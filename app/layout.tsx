import "./globals.css";

export const metadata = {
  title: "复盘网站 V1",
  description: "一个极简的每日复盘表格，记录今天的事、问题与解决方案"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <head />
      <body>{children}</body>
    </html>
  );
}
