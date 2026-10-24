import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const componentSource = await readFile(new URL("../src/components/imageTools.vue", import.meta.url), "utf8");
const bigSrcBody = componentSource.match(/const bigSrc = computed\(\(\) => \{([\s\S]*?)\n\}\);/);
assert.ok(bigSrcBody, "ImageTools must define its full-size URL computation");
const getBigSrc = new Function("props", bigSrcBody[1]);

test("full-size image URL preserves the media signature and removes only thumbnail size", () => {
  const thumbnailUrl = "http://127.0.0.1:10588/oss/role/image.jpg?exp=1792197418107&sig=abc123&size=20";
  assert.equal(
    getBigSrc({ src: thumbnailUrl }),
    "http://127.0.0.1:10588/oss/role/image.jpg?exp=1792197418107&sig=abc123",
  );
});

test("full-size image URL leaves an unsigned URL unchanged", () => {
  const url = "http://127.0.0.1:10588/oss/role/image.jpg";
  assert.equal(getBigSrc({ src: url }), url);
});
