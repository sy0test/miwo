import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
// 阶段2：素材与"段"的来源随引擎开关切换（v2 → o_shot/o_segment）
import { trackTableForScript, readShotsForScript, tracksForScript, normalizeVideoState } from "@/utils/shots/readShots";
const router = express.Router();

interface VideoItem {
  id: number;
  src: string;
  state: "未生成" | "生成中" | "已完成" | "生成失败";
}

interface TrackMedia {
  src: string;
  id?: number;
  fileType: "image" | "video" | "audio";
  videoDesc?: string;
}

interface TrackItem {
  id?: number;
  prompt: string;
  state: "未生成" | "生成中" | "已完成" | "生成失败";
  reason?: string;
  duration?: number;
  selectVideoId?: number;
  medias: TrackMedia[];
  videoList: VideoItem[];
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
  }),
  async (req, res) => {
    const { projectId, scriptId } = req.body;
    const projectData = await u.db("o_project").where("id", projectId).select("id", "videoModel", "mode").first();

    if (!projectData?.videoModel) {
      return res.status(400).json(success("项目未配置视频模型"));
    }
    let videoMode = "";
    try {
      videoMode = JSON.parse(projectData?.mode ?? "");
    } catch (e) {
      videoMode = projectData?.mode ?? "";
    }
    const isRef = Array.isArray(videoMode) ? true : false;

    // 阶段2：素材行的来源随引擎开关切换
    //   · legacy → `o_storyboard`（一行一镜的卡片）
    //   · v2     → `o_shot`（结构化镜），`videoDesc` 取它所属的 `o_segment`
    // 下游的分组键仍是 `trackId`：v2 下它就是 `segmentId`（片段 id），与轨道列表一一对应。
    const trackTable = await trackTableForScript(u.db, scriptId);
    const isSegments = trackTable === "o_segment";
    /**
     * v2：段 → 该段的镜 id 列表。
     *
     * ⚠ 必须单独存着：段的**参考资产**是按「镜 id」查出来的（`otherDataMap` 的键是
     * `o_shotAssets.shotId`）。以前是靠"每镜一条分镜项"顺带把镜 id 带下去查的，
     * 界面颗粒度改成"分镜=片段"、不再产出那些分镜项之后，这条链就断了 ——
     * 真机后果：每一段的参考资产图全空（"分镜里的数据都没了"）。
     */
    const shotIdsBySegment = new Map<number, number[]>();
    const storyboardList: any[] = isSegments
      ? await (async () => {
          const rows = await readShotsForScript(u.db, scriptId);
          /**
           * v2 下界面上的「分镜」就是**片段**（= 生成单位 = 分镜面板一张卡 = 工作台的一段）。
           * 分镜表里每片段下面那 1..N 行「序号」是**该片段内部的镜头细节**，不是一个分镜。
           *
           * 真机反馈（就是这里搞错的）：以前按"镜"生成条目 → 「选择分镜」弹窗里出现一堆
           * 重复的 P1/P2、工作台每段素材排里多出几张只有「文」的空卡，颗粒度和分镜面板对不上。
           * 现在改成**一段一条**（与分镜面板/工作台一一对应）。
           */
          const shotCountBySeg = new Map<number, number>();
          for (const sh of rows.shots) {
            const segId = Number(sh.segmentId);
            shotCountBySeg.set(segId, (shotCountBySeg.get(segId) ?? 0) + 1);
            const list = shotIdsBySegment.get(segId) ?? [];
            list.push(Number(sh.id));
            shotIdsBySegment.set(segId, list);
          }
          return rows.segments.map((seg: any, i: number) => ({
            id: Number(seg.id),
            // 0 起；前端显示「分镜 {index + 1}」
            index: i,
            segmentIndex: Number(seg.segmentIndex),
            // 分组键仍是片段 id（与 trackList 一一对应）
            trackId: Number(seg.id),
            shotCount: shotCountBySeg.get(Number(seg.id)) ?? 0,
            duration: Number(seg.videoDuration ?? seg.duration ?? 0),
            filePath: "",
            clipPath: null,
            videoDesc: seg.videoDesc ?? "",
            prompt: seg.videoDesc ?? null,
          }));
        })()
      : await u.db("o_storyboard").where({ scriptId, projectId }).orderBy("index", "asc");
    // 转绘第 5 步切出来的原片片段（o_storyboard.clipPath）→ 可直接用的 URL。
    // 单独放一张表而不是往行上挂字段：那张表的行类型是按数据库列生成的，
    // 挂个临时字段过不了类型检查（`filePath` 能这么用是因为它本来就是列）
    const clipSrcById = new Map<number, string>();
    await Promise.all(
      storyboardList.map(async (i) => {
        i.filePath = i.filePath ? await u.oss.getSmallImageUrl(i.filePath) : "";
        if (i.clipPath && i.id != null) clipSrcById.set(i.id, await u.oss.getFileUrl(i.clipPath));
      }),
    );
    const storyboardTrackRecord: Record<number, any[]> = {};
    storyboardList.forEach((i) => {
      const list = (storyboardTrackRecord[i.trackId!] ??= []);
      // v2 下**不往素材排里塞"分镜项"**：分镜的单位是片段（提示词由服务端按片段直接取，
      // 见 generateVideoPrompt 的 storyboardItemsForSegment），塞进来只会变成一张没有图的「文」卡，
      // 让人以为一个片段里还有好几个分镜（真机反馈）。
      if (!isSegments) {
        list.push({
          src: i.filePath,
          fileType: "image",
          sources: "storyboard",
          ...(i.prompt != null ? { prompt: i.videoDesc } : {}),
          ...(i.id != null ? { id: i.id } : {}),
          index: i.index,
        });
      }
      // 参考视频单列一条：sources 用 "clip"（generateVideo 按 o_storyboard.id 取 clipPath），
      // fileType 必须是 video —— 混成 image 的话会被当图片参考静默送出去。
      // 塞在 medias 里就等于「每个分镜默认带上原片作参考」，前端无需改动。
      const clipSrc = i.id != null ? clipSrcById.get(i.id) : undefined;
      if (clipSrc)
        list.push({
          src: clipSrc,
          fileType: "video",
          sources: "clip",
          prompt: `第 ${i.index} 镜原片`,
          id: i.id,
          index: i.index,
        });
    });
    // 按 storyboardId 分组的资产数据，key 为 storyboardId
    const otherDataMap: Record<number, any[]> = {};
    // 解析 videoMode 中 audioReference 的数量，例如 'audioReference:3' => 3
    const audioReferenceCount = (() => {
      if (!Array.isArray(videoMode)) return 0;
      const item = (videoMode as string[]).find((v) => v.toLowerCase().startsWith("audioreference:"));
      if (!item) return 0;
      const num = parseInt(item.split(":")[1], 10);
      return isNaN(num) ? 0 : num;
    })();
    if (isRef) {
      // ⚠ v2 下 `o_shotAssets` 的键是**镜 id**，不是片段 id（而 storyboardList 现在是"一段一条"）。
      // 以前这里能work是因为 storyboardList 里装的就是镜；界面颗粒度改成"分镜=片段"之后，
      // 必须显式用该集**所有镜 id**，否则一首段都查不到参考资产（真机后果：每段素材全空）。
      const storyIds = isSegments ? [...shotIdsBySegment.values()].flat() : storyboardList.map((s) => s.id);

      const assetDatas = await u
        .db(isSegments ? "o_shotAssets" : "o_assets2Storyboard")
        .leftJoin("o_assets", isSegments ? "o_shotAssets.assetId" : "o_assets2Storyboard.assetId", "o_assets.id")
        .leftJoin("o_image", "o_image.id", "o_assets.imageId")
        .whereIn(isSegments ? "o_shotAssets.shotId" : "o_assets2Storyboard.storyboardId", storyIds as number[])
        // 统一别名为 storyboardId，下游那段按 id 归组的逻辑不必改
        .select("o_assets.*", "o_image.filePath", isSegments ? "o_shotAssets.shotId as storyboardId" : "o_assets2Storyboard.storyboardId");

      const queryAudioIds = [...assetDatas.map((i) => i.id!), ...assetDatas.map((i) => i.assetsId!)].filter(Boolean);
      const assets2AudioData = await u
        .db("o_assetsRole2Audio")
        .leftJoin("o_assets", "o_assets.assetsId", "o_assetsRole2Audio.assetsAudioId")
        .leftJoin("o_image", "o_image.id", "o_assets.imageId")
        .whereIn("o_assetsRole2Audio.assetsRoleId", queryAudioIds)
        .select(
          "o_assets.id",
          "o_assets.name",
          "o_assetsRole2Audio.assetsRoleId",
          "o_assets.describe",
          "o_assets.type",
          "o_assets.prompt",
          "o_image.filePath",
        );
      const audioRecord: Record<string, any> = {};
      await Promise.all(
        assets2AudioData.map(async (i) => {
          if (!audioRecord[i.assetsRoleId]) audioRecord[i.assetsRoleId] = [];
          audioRecord[i.assetsRoleId].push({
            id: i.id,
            name: i.name,
            describe: i.describe,
            type: i.type,
            fileType: "audio" as const,
            sources: "assets",
            prompt: i.prompt,
            src: i.filePath ? await u.oss.getFileUrl(i.filePath) : "",
          });
        }),
      );

      await Promise.all(
        assetDatas.map(async (i) => {
          const item = {
            id: i.id,
            name: i.name,
            describe: i.describe,
            type: i.type,
            fileType: "image" as const,
            sources: "assets",
            src: i.filePath ? await u.oss.getSmallImageUrl(i.filePath) : "",
          };
          const sid = i.storyboardId as number;
          if (!otherDataMap[sid]) otherDataMap[sid] = [];
          otherDataMap[sid].push(item);
          if (audioRecord[i.id]) otherDataMap[sid].push(...audioRecord[i.id]);
          if (audioRecord[i.assetsId]) otherDataMap[sid].push(...audioRecord[i.assetsId]);
        }),
      );
    }

    // 阶段2：v2 下"段"由结构化片段投影而来（1:1，无空轨道）
    const trackData = await tracksForScript(u.db, projectId, scriptId);
    const videoList = await u.db("o_video").whereIn(
      "videoTrackId",
      trackData.map((t) => t.id),
    );
    const trackList: TrackItem[] = [];
    const trackIdMap = [...new Set<number>(trackData.map((t) => t.id!))];
    for (const trackId of trackIdMap) {
      const item = trackData.find((t) => t.id === trackId);
      trackList.push({
        id: trackId,
        duration: item?.duration ?? 0,
        prompt: item?.prompt || "",
        state: (item?.state as "未生成" | "生成中" | "已完成" | "生成失败") ?? "未生成",
        reason: item?.reason ?? "",
        selectVideoId: Number(item?.videoId)!,
        medias: (() => {
          const storyboardMedias = storyboardTrackRecord[trackId] ?? [];
          // 资产按「镜 id」查：legacy 用分镜项自己的 id；v2 直接用该段的镜 id（见 shotIdsBySegment 注释）
          const assetOwnerIds = isSegments ? (shotIdsBySegment.get(trackId) ?? []) : storyboardMedias.map((s) => Number(s.id));
          const assetMedias = assetOwnerIds.flatMap((id) => otherDataMap[id] ?? []);

          const seenAssetIds = new Set<number>();
          const uniqueAssets = assetMedias.filter((a) => {
            if (seenAssetIds.has(a.id)) return false;
            seenAssetIds.add(a.id);
            return true;
          });

          // 有 audioReference 时，按数量截取 audio 类型资产
          const audioCountMap: Record<string, number> = {};
          const filteredAssets = uniqueAssets.filter((a) => {
            if (a.fileType !== "audio" || audioReferenceCount === 0) return true;
            const key = String(a.id);
            audioCountMap[key] = (audioCountMap[key] ?? 0) + 1;
            // 统计当前 track 内 audio 总数，超过上限则过滤
            const totalAudio = Object.values(audioCountMap).reduce((s, n) => s + n, 0);
            return totalAudio <= audioReferenceCount;
          });

          const hasImageAssetData = filteredAssets.filter((i) => i.src);
          const notHasImageAssetData = filteredAssets.filter((i) => !i.src);

          return [...hasImageAssetData, ...storyboardMedias, ...notHasImageAssetData];
        })(),
        videoList: await Promise.all(
          videoList
            .filter((v) => v.videoTrackId === trackId)
            .map(async (v) => ({
              id: v.id!,
              src: v.filePath ? await u.oss.getFileUrl(v.filePath) : "",
              state: normalizeVideoState(v.state),
              errorReason: v?.errorReason ?? "",
            })),
        ),
      });
    }
    res.status(200).send(
      success({
        storyboardList: await Promise.all(
          storyboardList.map(async (s) => ({
            ...s,
            src: s.filePath,
          })),
        ),
        trackList,
      }),
    );
  },
);
