// 验证甘特图从当前 TypeScript 源码构建的执行时间对比逻辑。
const test = require("node:test");
const assert = require("node:assert/strict");

const compare = require(
  process.env.CT_GANTT_COMPARE_TEST_BUILD
    || "../realtime_scheduler/frontend/assets/gantt_execution_compare.js",
);

test("reconstructExecutionLog uses every Running/Done pair when MoveID is reused", () => {
  const entries = [
    { Describe: "AlgSchedule", SimTime: 0 },
    { Describe: "AlgOutput", Info: { MoveList: [
      { MoveID: 7, MoveType: 9, ModuleName: "PM1", StartTime: 2, EndTime: 4 },
    ] } },
    { Describe: "AlgUpdateMove", Info: { MoveID: 7, MoveState: 0, StartTime: 3, EndTime: -1 } },
    { Describe: "AlgUpdateMove", Info: { MoveID: 7, MoveState: 1, StartTime: 3, EndTime: 6 } },
    { Describe: "AlgSchedule", SimTime: 10 },
    { Describe: "AlgOutput", Info: { MoveList: [
      { MoveID: 7, MoveType: 9, ModuleName: "PM1", StartTime: 12, EndTime: 15 },
    ] } },
    { Describe: "AlgUpdateMove", Info: { MoveID: 7, MoveState: 0, StartTime: 13, EndTime: -1 } },
    { Describe: "AlgUpdateMove", Info: { MoveID: 7, MoveState: 1, StartTime: 13, EndTime: 18 } },
  ];

  const result = compare.reconstructExecutionLog(entries);
  assert.ok(result);
  assert.equal(result.records.length, 2);
  assert.deepEqual(
    result.records.map((record) => [record.actualStart, record.actualEnd]),
    [[3, 6], [13, 18]],
  );
  assert.equal(result.unmatchedExecutions.length, 0);
});

test("reconstructExecutionLog keeps a Running-only move drawable with an estimated end", () => {
  const result = compare.reconstructExecutionLog([
    { Describe: "AlgSchedule", SimTime: 0 },
    { Describe: "AlgOutput", Info: { MoveList: [
      { MoveID: 1, StartTime: 10, EndTime: 14 },
    ] } },
    { Describe: "AlgUpdateMove", Info: { MoveID: 1, MoveState: 0, StartTime: 20, EndTime: -1 } },
  ]);

  assert.ok(result);
  assert.equal(result.records[0].actualStart, 20);
  assert.equal(result.records[0].actualEnd, null);
  assert.equal(result.records[0].actualEndKnown, false);
});

test("duration-only excludes a pure shift and includes an actual duration change", () => {
  const shifted = { executed: true, planStart: 10, planEnd: 15, start: 12, end: 17 };
  const stretched = { executed: true, planStart: 10, planEnd: 15, start: 12, end: 19 };

  assert.equal(compare.hasExecutionTimeDifference(shifted, false), true);
  assert.equal(compare.hasExecutionTimeDifference(shifted, true), false);
  assert.equal(compare.hasExecutionTimeDifference(stretched, true), true);
});

test("platform results retain actual geometry and expose original duration", () => {
  const times = compare.resolveMoveTimes({
    StartTime: 12, EndTime: 24, PlannedStartTime: 10, PlannedEndTime: 20,
  });
  assert.deepEqual(times, { start: 12, end: 24, duration: 12, planStart: 10, planEnd: 20 });
  assert.equal(compare.hasExecutionTimeDifference({ ...times, executed: true }, true), true);
});

test("plain results and unfinished notifications preserve their timing semantics", () => {
  assert.deepEqual(compare.resolveMoveTimes({ StartTime: 10, EndTime: 20 }),
    { start: 10, end: 20, duration: 10, planStart: 10, planEnd: 20 });
  assert.deepEqual(compare.resolveMoveTimes({ raw: { StartTime: 10, EndTime: 20 }, actualStart: 25, actualEnd: null }),
    { start: 25, end: 35, duration: 10, planStart: 10, planEnd: 20 });
});
