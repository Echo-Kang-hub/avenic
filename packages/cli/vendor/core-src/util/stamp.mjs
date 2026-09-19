const pad = (value) => String(value).padStart(2, "0");

/**
 * The one way Avenic writes a moment: "2026-09-19 14:03", in the reader's own
 * time zone. Every host shows timestamps, and two hosts showing the same
 * session updated at two different times is a bug report waiting to happen.
 * An unreadable value is reported as such rather than as an epoch date.
 */
export function shortTimestamp(value = new Date()) {
  // 显式的 null/undefined 是「没有这个时间」，不是 1970：默认参数只兜住「没传参」，
  // 传进来的空值必须原样回答 null，否则每个空时间戳都会印成 1970-01-01 08:00。
  if (value === null || value === undefined || value === "") return null;
  const when = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(when.getTime())) return null;
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`;
}
