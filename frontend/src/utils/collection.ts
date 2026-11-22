/** 收藏夹弹窗的跨页面事件通道：任意文章卡片/详情页都能唤起同一个弹窗。 */
export interface CollectionTarget {
  id: string;
  title: string;
  is_collected?: boolean;
}

export const openCollectionModal = (target: CollectionTarget): void => {
  window.dispatchEvent(new CustomEvent('wb:open-collection', { detail: target }));
};

export interface CollectionChange {
  postId: string;
  is_collected: boolean;
  group_name?: string;
}

export const emitCollectionChanged = (change: CollectionChange): void => {
  window.dispatchEvent(new CustomEvent('wb:collection-changed', { detail: change }));
};

export const onCollectionChanged = (cb: (c: CollectionChange) => void): (() => void) => {
  const handler = (e: Event) => cb((e as CustomEvent).detail as CollectionChange);
  window.addEventListener('wb:collection-changed', handler);
  return () => window.removeEventListener('wb:collection-changed', handler);
};
