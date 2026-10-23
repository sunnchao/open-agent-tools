import assert from "node:assert/strict";
import { test } from "node:test";
import { describeSchedule, WEEKDAY_LABELS } from "./report.js";

test("report schedule descriptions retain daily and weekly wording", () => {
  assert.equal(describeSchedule({ frequency: "daily", time: "09:00" }), "每天 09:00");
  assert.equal(
    describeSchedule({ frequency: "weekly", time: "08:30", weekday: 2 }),
    `每${WEEKDAY_LABELS[2]} 08:30`,
  );
  assert.equal(describeSchedule({ frequency: "weekly", time: "20:00" }), "每周日 20:00");
});
