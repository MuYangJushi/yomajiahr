// 响应式宽度工具：Modal / Drawer 写死的 `width: 720/760/...` 在窄屏（手机）会溢出视口。
// `respWidth(preferred)` 返回 `min(preferred, viewport)`，SSR/初次渲染时回退为 preferred。
//
// ⚠️ 这是「render-time 取值」，组件挂载后 resize 不会重算。够用：Modal/Drawer 是即用即开，
// 关掉重开会重新读 window.innerWidth。如果未来需要 live-resize 再换成 hook + state。
export function respWidth(preferred: number): number {
  if (typeof window === "undefined") return preferred;
  return Math.min(preferred, window.innerWidth);
}
