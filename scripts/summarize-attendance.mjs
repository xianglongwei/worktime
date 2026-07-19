import { readFile } from "node:fs/promises";

const inputPath = process.argv[2];

if (!inputPath) {
  console.error("Usage: node scripts/summarize-attendance.mjs data/attendance-YYYYMM.json");
  process.exit(1);
}

const payload = JSON.parse(await readFile(inputPath, "utf8"));
const records = payload.result?.records ?? [];

const rows = records.map((record) => ({
  date: record.attendanceDate,
  dayType: record.dayType_dictText,
  status: record.status_dictText,
  exception: record.exception_dictText ?? "",
  workStart: record.workingTime ?? "",
  workEnd: record.offworkTime ?? "",
  clockStart: record.clockWorkTime ?? "",
  clockEnd: record.clockOffWorkTime ?? "",
  duration: record.duration ?? 0,
  workLength: record.workLength ?? 0,
  leaveHours: record.leaveDuration ?? 0,
  missHours: record.missDuration ?? 0,
  overtimeHours: record.overtimeDuration ?? 0,
  statusIn: record.statusStr ?? "",
  statusOut: record.offStatusStr ?? "",
}));

const abnormal = rows.filter((row) => row.status !== "正常" || row.exception || row.missHours > 0);
const totals = rows.reduce(
  (acc, row) => {
    acc.duration += Number(row.duration) || 0;
    acc.workLength += Number(row.workLength) || 0;
    acc.leaveHours += Number(row.leaveHours) || 0;
    acc.missHours += Number(row.missHours) || 0;
    acc.overtimeHours += Number(row.overtimeHours) || 0;
    return acc;
  },
  { duration: 0, workLength: 0, leaveHours: 0, missHours: 0, overtimeHours: 0 },
);

console.log(`Records: ${rows.length}`);
console.log(`Normal: ${rows.length - abnormal.length}`);
console.log(`Abnormal: ${abnormal.length}`);
console.log(
  `Totals: actual=${totals.duration.toFixed(2)}h, required=${totals.workLength.toFixed(2)}h, leave=${totals.leaveHours.toFixed(2)}h, missing=${totals.missHours.toFixed(2)}h, overtime=${totals.overtimeHours.toFixed(2)}h`,
);
console.log("");
console.table(rows);

if (abnormal.length > 0) {
  console.log("Abnormal records:");
  console.table(abnormal);
}
