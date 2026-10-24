import assert from "node:assert/strict";
import test from "node:test";
import { primaryActionFor, secondaryActionsFor, statusViewFor, stepAccessFor, stageText } from "../src/views/redraw/logic.ts";

const base = {
  extractState: 1,
  redrawState: 0,
  stage: null,
  progress: null,
  segmentCount: 0,
  assetTotal: 0,
  assetsConfirmed: 0,
  clipsReady: false,
  segmentCap: 15,
  capConfirmed: false,
};

test("stage text maps known stages and falls back to the raw value", () => {
  assert.equal(stageText("cut"), "预处理·切点");
  assert.equal(stageText("transcribe"), "预处理·转写");
  assert.equal(stageText(null), "分析中");
  assert.equal(stageText("weird"), "weird");
});

test("status view follows redrawState first, then extractState", () => {
  assert.equal(statusViewFor({ extractState: 0, redrawState: 0, stage: "cut" }).label, "预处理·切点");
  assert.equal(statusViewFor({ extractState: -1, redrawState: 0 }).label, "失败");
  assert.equal(statusViewFor({ extractState: 1, redrawState: 1 }).label, "待认账");
  assert.equal(statusViewFor({ extractState: 1, redrawState: 2 }).label, "资产已确认");
  assert.equal(statusViewFor({ extractState: 1, redrawState: 3 }).label, "转绘待确认");
  assert.equal(statusViewFor({ extractState: 1, redrawState: 4 }).label, "可生成");
  assert.equal(statusViewFor({ extractState: 2, redrawState: 0 }).label, "等待提取");
});

test("primary action covers the whole redraw state machine", () => {
  assert.equal(primaryActionFor(null), null);
  assert.equal(primaryActionFor({ ...base, extractState: 0 }).disabled, true);
  assert.equal(primaryActionFor({ ...base, redrawState: -1 }).action, "analyze");
  assert.equal(primaryActionFor({ ...base, redrawState: 0 }).action, "analyze");
  assert.equal(primaryActionFor({ ...base, redrawState: 1 }).route, "session");
  assert.equal(primaryActionFor({ ...base, redrawState: 2 }).action, "generateStoryboard");
  assert.equal(primaryActionFor({ ...base, redrawState: 3 }).route, "review");
  assert.equal(primaryActionFor({ ...base, redrawState: 4 }).route, "/production");
  assert.equal(primaryActionFor(base, { busy: true }).disabled, true);
});

test("secondary actions only expose re-run/cut when meaningful", () => {
  assert.deepEqual(secondaryActionsFor(null), []);
  assert.deepEqual(secondaryActionsFor({ ...base, extractState: 0 }), []);
  const s1 = secondaryActionsFor({ ...base, redrawState: 1 });
  assert.deepEqual(s1.map((x) => x.key), ["reanalyze"]);
  const s4 = secondaryActionsFor({ ...base, redrawState: 4, clipsReady: false });
  assert.deepEqual(s4.map((x) => x.key), ["reanalyze", "cut"]);
  assert.equal(s4[1].label, "切原片");
  assert.equal(secondaryActionsFor({ ...base, redrawState: 4, clipsReady: true })[1].label, "已切原片 · 重切");
});

test("step gating requires all assets confirmed and a confirmed segment cap", () => {
  assert.equal(stepAccessFor({ assetTotal: 3, assetsConfirmed: 2, capConfirmed: true }).step3, false);
  assert.equal(stepAccessFor({ assetTotal: 3, assetsConfirmed: 3, capConfirmed: false }).canGenerate, false);
  assert.equal(stepAccessFor({ assetTotal: 0, assetsConfirmed: 0, capConfirmed: true }).step3, false);
  const ok = stepAccessFor({ assetTotal: 3, assetsConfirmed: 3, capConfirmed: true });
  assert.equal(ok.canGenerate, true);
  assert.equal(ok.blockedReason, null);
});
