/**
 * 把本地文件读成 dataURL（带 `data:<mime>;base64,` 前缀）。
 * 生图接口的 base64 字段要的就是这个形状。
 */
export function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
