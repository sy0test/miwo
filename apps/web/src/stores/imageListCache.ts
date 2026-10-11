import "@/views/production/components/workbench/type/type";
import axios from "@/utils/axios";

/**
 * 图片列表缓存 Pinia Store
 * 结构: { [projectId]: { [scriptId]: { [trackId]: CachedUploadItem[] } } }
 *
 * 缓存中的 src 只存储文件路径（不含 origin/host:port），
 * 显示时通过后端接口批量获取当前可用的完整 URL，
 * 解决后端端口变化导致缓存失效的问题。
 */

type CacheKey = string | number;

/** 缓存中存储的项，src 为纯文件路径（不含 origin） */
type CachedUploadItem = Omit<UploadItem, "src"> & { src?: string };

type ImageListCacheData = Record<CacheKey, Record<CacheKey, Record<CacheKey, CachedUploadItem[]>>>;

/** 用于向后端请求 URL 的标识信息 */
interface ResolveUrlItem {
  id: number | null | undefined;
  sources: string | undefined;
}

/** 生成 urlMap 的复合键: "id:sources" */
function makeUrlKey(id: number | null | undefined, sources: string | undefined): string {
  return `${id ?? ""}:${sources ?? ""}`;
}

/** 从完整 URL 中提取路径部分（去掉 origin） */
function extractPath(url: string | undefined): string {
  if (!url) return "";
  // data: / blob: 等特殊协议直接保留
  if (url.startsWith("data:") || url.startsWith("blob:")) return url;
  try {
    const u = new URL(url);
    return u.pathname + u.search + u.hash;
  } catch {
    // 如果已经是路径或者解析失败，直接返回
    return url;
  }
}

/** 将 UploadItem[] 转为缓存格式（src 只保留路径） */
function toCachedItems(items: (UploadItem | TrackMedia)[]): CachedUploadItem[] {
  return items.map((item) => ({
    ...JSON.parse(JSON.stringify(item)),
    src: extractPath(item.src),
  }));
}

export default defineStore(
  "imageListCache",
  () => {
    const cacheData = ref<ImageListCacheData>({});

    /** URL 解析缓存: "id:sources" -> 后端返回的完整 URL，避免重复请求 */
    const urlMap = ref<Record<string, string>>({});

    /**
     * 批量通过 id + sources 获取当前可用的完整 URL
     *
     * 请求示例:
     *   POST /production/workbench/getFileUrl
     *   Body: { items: [{ id: 1, sources: "storyboard" }, { id: 2, sources: "assets" }] }
     *
     * 期望响应:
     *   { data: [{ id: 1, sources: "storyboard", url: "http://..." }, ...] }
     *   或 { data: { "1:storyboard": "http://...", ... } }
     */
    async function resolveUrls(items: ResolveUrlItem[]): Promise<Record<string, string>> {
      if (!items.length) return {};
      // 过滤掉已经解析过的、id 无效的项
      const needResolve = items.filter((item) => {
        if (item.id == null) return false;
        const key = makeUrlKey(item.id, item.sources);
        return true;
      });
      if (needResolve.length) {
        try {
          const { data } = await axios.post("/production/workbench/getFileUrl", {
            items: needResolve.map((item) => ({ id: item.id, sources: item.sources })),
          });
          // axios 拦截器已返回 response.data，后端可能再包一层 { data: { ... } }
          const rawData = data.data;

          // 兼容多种后端响应格式
          const resolved: Record<string, string> = {};
          if (Array.isArray(rawData)) {
            // 格式: [{ id: 1, sources: "storyboard", url: "http://..." }, ...]
            rawData.forEach((item: any) => {
              if (item.id != null && item.url) {
                const key = makeUrlKey(item.id, item.sources);
                resolved[key] = item.url;
              }
            });
          } else if (rawData && typeof rawData === "object" && !Array.isArray(rawData)) {
            // 格式: { "id:sources": fullUrl } 或 { [compositeKey]: fullUrl }
            Object.entries(rawData).forEach(([key, url]) => {
              resolved[key] = url as string;
            });
          }

          // 替换整个对象以触发 Vue 响应式更新
          urlMap.value = { ...urlMap.value, ...resolved };
        } catch (e) {
          console.warn("[imageListCache] resolveUrls 请求失败，降级使用路径", e);
        }
      }
      // 返回所有请求项的映射（含之前缓存的）
      const result: Record<string, string> = {};
      items.forEach((item) => {
        const key = makeUrlKey(item.id, item.sources);
        result[key] = urlMap.value[key] || item.id?.toString() || "";
      });
      return result;
    }

    /** 通过 id + sources 同步解析为完整 URL（优先走内存缓存） */
    function resolveUrlSync(id: number | null | undefined, sources: string | undefined, fallbackPath?: string): string {
      if (id != null) {
        const key = makeUrlKey(id, sources);
        if (urlMap.value[key]) return urlMap.value[key];
      }
      // 降级返回原始路径
      return fallbackPath || "";
    }

    /** 将缓存项还原为带完整 URL 的 UploadItem[]（同步版，需先调用 resolveUrls） */
    function toFullItems(items: CachedUploadItem[]): UploadItem[] {
      return items.map((item) => ({
        ...item,
        src: resolveUrlSync(item.id, (item as any).sources, item.src),
      })) as UploadItem[];
    }

    /**
     * 获取指定 project / script / track 的缓存图片列表
     * 返回的 src 为已解析的完整 URL（需先调用 resolveUrls 预热）
     */
    function getCache(projectId: CacheKey, scriptId: CacheKey, trackId: CacheKey): UploadItem[] | undefined {
      const cached = cacheData.value[projectId]?.[scriptId]?.[trackId];
      if (!cached) return undefined;
      return toFullItems(cached);
    }

    /**
     * 获取缓存并异步解析 URL（推荐使用）
     * 自动向后端请求路径对应的完整 URL，返回解析后的列表
     */
    async function getCacheWithResolve(projectId: CacheKey, scriptId: CacheKey, trackId: CacheKey): Promise<UploadItem[] | undefined> {
      const cached = cacheData.value[projectId]?.[scriptId]?.[trackId];
      if (!cached) return undefined;
      // 收集所有需要解析的 id + sources
      const resolveItems: ResolveUrlItem[] = cached
        .filter((item) => item.id != null)
        .map((item) => ({ id: item.id, sources: (item as any).sources }));
      await resolveUrls(resolveItems);
      return toFullItems(cached);
    }

    /**
     * 获取原始缓存数据（src 为路径，不解析 URL）
     */
    function getRawCache(projectId: CacheKey, scriptId: CacheKey, trackId: CacheKey): CachedUploadItem[] | undefined {
      return cacheData.value[projectId]?.[scriptId]?.[trackId];
    }

    /**
     * 设置缓存（自动提取 src 路径部分）
     * 同时将完整 URL 写入 urlMap，避免新增图片后裂图
     */
    function setCache(projectId: CacheKey, scriptId: CacheKey, trackId: CacheKey, imageList: (UploadItem | TrackMedia)[]): void {
      if (!cacheData.value[projectId]) {
        cacheData.value[projectId] = {};
      }
      if (!cacheData.value[projectId][scriptId]) {
        cacheData.value[projectId][scriptId] = {};
      }
      // 将带完整 URL 的 src 通过 id:sources 写入 urlMap
      let urlMapDirty = false;
      imageList.forEach((item) => {
        if (!item.src || item.id == null) return;
        const key = makeUrlKey(item.id, (item as any).sources);
        if (!urlMap.value[key]) {
          urlMap.value[key] = item.src;
          urlMapDirty = true;
        }
      });
      if (urlMapDirty) {
        urlMap.value = { ...urlMap.value };
      }
      cacheData.value[projectId][scriptId][trackId] = toCachedItems(imageList);
    }

    /**
     * 删除指定轨道的缓存
     */
    function removeCache(projectId: CacheKey, scriptId: CacheKey, trackId: CacheKey): void {
      if (cacheData.value[projectId]?.[scriptId]) {
        delete cacheData.value[projectId][scriptId][trackId];
      }
    }

    /**
     * 在指定 project / script 下所有轨道中，删除匹配指定图片 id 的图片项
     * @param projectId 项目 ID
     * @param scriptId  脚本 ID
     * @param imageId   要删除的图片 id
     */
    function removeImageById(projectId: CacheKey, scriptId: CacheKey, imageId: number): void {
      const scriptCache = cacheData.value[projectId]?.[scriptId];
      if (!scriptCache) return;
      Object.keys(scriptCache).forEach((trackId) => {
        scriptCache[trackId] = scriptCache[trackId].filter((item) => item.id !== imageId);
      });
    }

    /**
     * 清空指定 project / script 下的所有轨道缓存
     */
    function clearScriptCache(projectId: CacheKey, scriptId: CacheKey): void {
      if (cacheData.value[projectId]) {
        delete cacheData.value[projectId][scriptId];
      }
    }
    function clearProjectCache(projectId: CacheKey): void {
      if (cacheData.value && cacheData.value?.[projectId]) {
        delete cacheData.value[projectId];
      }
    }
    /**
     * 从后端返回的 trackList 批量初始化缓存。
     *
     * ⚠ 这里同时承担**失效**职责：缓存是持久化到本地存储的，重跑分镜面板之后
     * `o_storyboard` 行会重建、trackId 会换、素材会变，但缓存里的旧快照还在，
     * 于是「重跑完了、工作台看到的还是上一轮的素材」——用户完全无法归因。
     *
     * 失效判据用的是**后端说了算的那部分**：后端的 medias 都是 DB 实体（分镜行 / 资产 / 切片），
     * 一律带数字 id；而本地手工加的素材（上传的图片/视频/音频）带的是 blob:/data: 的 src、没有 id。
     * 所以：
     *   · 后端这次有的条目 → 以它为准（去掉缓存里 id 相同但内容已变的旧项）
     *   · 后端这次没有的、且**带 id** 的旧条目 → 已被删除或换了轨，丢弃
     *   · 没有 id 的本地新增条目 → 保留（那是用户自己的劳动成果）
     * 这样既治「旧素材残留」，又不会把用户手工加的参考图清掉。
     */
    function initCacheFromTrackList(projectId: CacheKey, scriptId: CacheKey, trackList: TrackItem[]): void {
      trackList.forEach((track) => {
        if (track.id == null) return;
        const fresh = toCachedItems(track.medias);
        const freshIds = new Set(fresh.map((m) => m.id).filter((id): id is number => id != null));
        const cached = getRawCache(projectId, scriptId, track.id);

        if (!cacheData.value[projectId]) cacheData.value[projectId] = {};
        if (!cacheData.value[projectId][scriptId]) cacheData.value[projectId][scriptId] = {};

        if (!cached) {
          cacheData.value[projectId][scriptId][track.id] = fresh;
          return;
        }
        // 后端这条轨道这次一个 DB 实体都没有 → 缓存里那些有 id 的都已失效；只留本地手工素材
        if (freshIds.size === 0) {
          cacheData.value[projectId][scriptId][track.id] = cached.filter((m) => m.id == null);
          return;
        }
        // 其余情况：保留本地手工素材（无 id）+ 后端这次的 fresh。
        // 缓存里那些「有 id 但后端这次不再返回」的条目会被丢弃（已被删除/换了轨）。
        const localOnly = cached.filter((m) => m.id == null);
        cacheData.value[projectId][scriptId][track.id] = [...localOnly, ...fresh];
      });
    }

    /**
     * 从后端返回的 trackList 强制覆盖缓存
     */
    function forceInitCacheFromTrackList(projectId: CacheKey, scriptId: CacheKey, trackList: TrackItem[]): void {
      if (cacheData.value[projectId]) {
        delete cacheData.value[projectId][scriptId];
      }
      if (!cacheData.value[projectId]) cacheData.value[projectId] = {};
      cacheData.value[projectId][scriptId] = {};
      trackList.forEach((track) => {
        if (track.id == null) return;
        cacheData.value[projectId][scriptId][track.id] = toCachedItems(track.medias);
      });
    }

    /**
     * 批量预热：收集指定 script 下所有轨道的文件路径，一次性向后端请求 URL
     * 建议在 getGenerateData 拿到数据后调用一次
     */
    async function warmUpUrls(projectId: CacheKey, scriptId: CacheKey): Promise<void> {
      const scriptCache = cacheData.value[projectId]?.[scriptId];
      if (!scriptCache) return;
      const allItems: ResolveUrlItem[] = [];
      const seen = new Set<string>();
      Object.values(scriptCache).forEach((items) => {
        items.forEach((item) => {
          if (item.id == null) return;
          const key = makeUrlKey(item.id, (item as any).sources);
          if (!seen.has(key)) {
            seen.add(key);
            allItems.push({ id: item.id, sources: (item as any).sources });
          }
        });
      });
      await resolveUrls(allItems);
    }

    /**
     * 清除 URL 解析缓存（当后端地址/端口变更时调用）
     */
    function clearUrlMap(): void {
      urlMap.value = {};
    }

    return {
      cacheData,
      urlMap,
      getCache,
      getCacheWithResolve,
      getRawCache,
      setCache,
      removeCache,
      removeImageById,
      clearScriptCache,
      initCacheFromTrackList,
      forceInitCacheFromTrackList,
      resolveUrls,
      resolveUrlSync,
      warmUpUrls,
      clearUrlMap,
      clearProjectCache,
    };
  },
  { persist: { pick: ["cacheData"] } },
);
