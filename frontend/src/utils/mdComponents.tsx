/**
 * 公共 Markdown 渲染组件：表格外层包一个可横向滚动的容器，
 * 并带上主题化表格样式所需的 class。
 *
 * 项目未启用 @tailwindcss/typography，`.prose table` 只有 display:block，
 * 没有边框/内边距/表头背景，GFM 表格虽然被 remark-gfm 解析了却「看不出来」。
 * 分享给详情页两处视图与编辑器预览，保证三处渲染一致。
 */
export const mdTableComponents = {
  table: ({ children, ...props }: any) => (
    <div className="wb-md-table-wrap">
      <table className="wb-md-table" {...props}>{children}</table>
    </div>
  ),
};
