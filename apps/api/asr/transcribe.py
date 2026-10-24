#!/usr/bin/env python3
"""faster-whisper 词级转写 CLI（转绘改造 spec §5.3）。

契约（Node 侧 src/utils/asr/index.ts 按它调用）：

    python transcribe.py --wav <16k 单声道 wav> --out <输出 json> \
        --model medium --compute int8 [--language zh]

输出（--out 指向的文件）：

    {
      "language": "zh",
      "duration": 132.4,
      "segments": [{"start": 0.0, "end": 2.3, "text": "..."}],
      "words":    [{"word": "第一句", "start": 0.12, "end": 0.86}]
    }

四条硬规则（与 spec 一致）：
  1. **先检语种再转写**：不传 --language 时用 detect_language 取前 30s 判定，再显式传回 transcribe。
     给错语种 Whisper 会「翻译」而不是转写 —— 那是静默的数据错误。
  2. task="transcribe"，**禁止 translate**。
  3. words 为空 ⇒ 退出码 **3**（台词配额需要词级时间戳，不允许静默降级成段级）。
  4. vad_filter=True 跳过静音。

退出码：0 成功 / 3 没有词级时间戳 / 2 参数或依赖错误 / 1 其它失败。
"""

import argparse
import json
import os
import sys
import traceback

EXIT_NO_WORDS = 3
EXIT_BAD_ENV = 2


def parse_args(argv):
    p = argparse.ArgumentParser(description="faster-whisper 词级转写")
    p.add_argument("--wav", required=True, help="16k 单声道 wav 绝对路径")
    p.add_argument("--out", required=True, help="输出 JSON 绝对路径")
    p.add_argument("--model", default=os.environ.get("MIWO_ASR_MODEL", "medium"), help="模型档位：small/medium/large-v3")
    p.add_argument("--compute", default=os.environ.get("MIWO_ASR_COMPUTE", "int8"), help="compute_type，CPU 默认 int8")
    p.add_argument("--model-dir", default=os.environ.get("MIWO_ASR_MODEL_DIR", ""), help="模型缓存目录（空 = 由 faster-whisper 决定）")
    p.add_argument("--language", default="", help="显式语种；空 = 先检测再转写")
    p.add_argument("--beam-size", type=int, default=5)
    return p.parse_args(argv)


def load_model(args):
    try:
        from faster_whisper import WhisperModel
    except ImportError as e:  # pragma: no cover - 依赖缺失是部署问题，不是逻辑分支
        sys.stderr.write("faster-whisper 未安装：" + str(e) + "\n请先 pip install -r asr/requirements.txt\n")
        raise SystemExit(EXIT_BAD_ENV)

    kwargs = {"device": "cpu", "compute_type": args.compute}
    if args.model_dir:
        os.makedirs(args.model_dir, exist_ok=True)
        # faster-whisper 的 model_size_or_path 接受本地目录；找不到时退回按名字下载（部署机应已固化）
        candidate = os.path.join(args.model_dir, args.model)
        kwargs["model_size_or_path"] = candidate if os.path.isdir(candidate) else args.model
    else:
        kwargs["model_size_or_path"] = args.model
    return WhisperModel(**kwargs)


def detect_language(model, wav_path):
    """返回 (language, probability)。不同 faster-whisper 版本返回元组长度不同，按位置取前两项。"""
    result = model.detect_language(wav_path)
    if isinstance(result, tuple):
        language = result[0]
        prob = result[1] if len(result) > 1 else None
        return language, prob
    return result, None


def main(argv):
    args = parse_args(argv)
    if not os.path.isfile(args.wav):
        sys.stderr.write("wav 不存在：" + args.wav + "\n")
        return EXIT_BAD_ENV

    model = load_model(args)
    language = args.language.strip() or None
    detected = None
    if not language:
        try:
            language, prob = detect_language(model, args.wav)
            detected = {"language": language, "probability": prob}
            sys.stderr.write("[asr] 检测语种：" + str(language) + "\n")
        except Exception as e:
            # 检测失败不阻塞转写：让 transcribe 自己 auto-detect（行为与显式传 None 一致）
            sys.stderr.write("[asr] detect_language 失败，退回自动检测：" + str(e) + "\n")

    segments_iter, info = model.transcribe(
        args.wav,
        language=language,
        task="transcribe",
        word_timestamps=True,
        vad_filter=True,
        beam_size=args.beam_size,
    )

    segments = []
    words = []
    for seg in segments_iter:
        segments.append({"start": float(seg.start), "end": float(seg.end), "text": (seg.text or "").strip()})
        for w in seg.words or []:
            word = (w.word or "").strip()
            if not word:
                continue
            words.append({"word": word, "start": float(w.start), "end": float(w.end)})

    detected_language = getattr(info, "language", None) or language or ""
    payload = {
        "language": detected_language,
        "duration": float(getattr(info, "duration", 0.0) or 0.0),
        "segments": segments,
        "words": words,
    }
    if detected:
        payload["detected"] = detected

    out_dir = os.path.dirname(os.path.abspath(args.out))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)

    if not words:
        sys.stderr.write(
            "转写完成但没有词级时间戳（words 为空）：台词配额需要词级时间戳，不允许静默降级。"
            "请检查音频是否有语音、vad_filter 是否把语音判成静音。\n"
        )
        return EXIT_NO_WORDS

    sys.stderr.write(
        "[asr] 完成：语种 " + str(detected_language) + "，段 " + str(len(segments)) + "，词 " + str(len(words)) + "\n"
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        sys.exit(1)
