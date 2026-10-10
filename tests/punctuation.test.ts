import { test } from "node:test";
import assert from "node:assert/strict";
import { containsCJK, normalizePunctuation } from "../frontend/src/utils/punctuation";

/** 幂等校验：规范化两次与一次结果一致。 */
function expectIdempotent(input: string, expected: string): void {
  assert.equal(normalizePunctuation(input), expected, input);
  assert.equal(normalizePunctuation(expected), expected, "Not idempotent: " + input);
}

test("containsCJK: 汉字判定", () => {
  assert.equal(containsCJK("hello"), false);
  assert.equal(containsCJK("3.14"), false);
  assert.equal(containsCJK("你好"), true);
  assert.equal(containsCJK("中文 hello 混排"), true);
  assert.equal(containsCJK(""), false);
});

test("Chinese punctuation and spacing normalize idempotently", () => {
  const cases = [
    ["你好，世界。", "你好, 世界."],
    ["先，然后；最后！", "先, 然后; 最后!"],
    ["真的吗？", "真的吗?"],
    ["他说：“你好”；为什么？", "他说: \"你好\"; 为什么?"],
    ["苹果、香蕉、梨。", "苹果, 香蕉, 梨."],
    ["（括号）【方括号】", "(括号)[方括号]"],
    ["约40%～50%。", "约40%~50%."],
    ["好的， 没问题。", "好的, 没问题."],
    ["hello，世界。", "hello, 世界."],
    ["好的, 然后。 接下来。", "好的, 然后. 接下来."],
  ];
  for (const [input, expected] of cases) expectIdempotent(input, expected);
});

test("纯英文原样返回", () => {
  const inputs = [
    "Hello,world. This is 3.14!",
    "README：setup",
    "`const value = 'fullwidth，punctuation'`",
    "```\nconsole.log(1, 2)\n```",
  ];
  for (const input of inputs) assert.equal(normalizePunctuation(input), input);
});

test("normalization preserves numbers, filenames, domains, URLs and times", () => {
  const cases = [
    ["圆周率约3.14。", "圆周率约3.14."],
    ["版本是1.2.3。", "版本是1.2.3."],
    ["温度23°C，湿度40%。", "温度23°C, 湿度40%."],
    ["看看package.json文件。", "看看package.json文件."],
    ["访问goo.gl链接。", "访问goo.gl链接."],
    ["看 https://example.com。", "看 https://example.com."],
    ["10:30 开始。", "10:30 开始."],
  ];
  for (const [input, expected] of cases) expectIdempotent(input, expected);
});

test("closed and unclosed fenced code remain unchanged", () => {
  const input = "```py\nprint(\"你好，世界\")\n```\n完了。";
  expectIdempotent(input, "```py\nprint(\"你好，世界\")\n```\n完了.");
  expectIdempotent("```\n乱，写。", "```\n乱，写。");
});

test("用户消息中的行内代码不属于围栏豁免范围", () => {
  const output = normalizePunctuation("说明：`你好，世界。`");
  assert.ok(output.includes("`你好, 世界."));
  assert.doesNotMatch(output, /[，。]/);
  assert.equal(normalizePunctuation(output), output);
});
