import React from 'react';
import { Reply } from 'lucide-react';

interface Props {
  isMe: boolean;
  /** 当前消息是否为选中态（移动端常驻显示操作按钮） */
  active: boolean;
  onReply: () => void;
  /** 是否可撤回（仅自己的消息在时限内 / 管理员） */
  canRecall?: boolean;
  onRecall?: () => void;
  /**
   * 私聊的头部行在气泡上方，需要把按钮中线压到气泡中线；
   * 用 rem 而非固定 px，跟随用户设置的根字号缩放。
   */
  compensateHeader?: boolean;
}

/**
 * 私聊与群聊共用的消息操作区：回复 + 可选撤回。
 * 按钮与气泡垂直居中（self-center），样式与热区在两种会话里完全一致。
 */
export const MessageActions: React.FC<Props> = ({
  isMe,
  active,
  onReply,
  canRecall = false,
  onRecall,
  compensateHeader = false,
}) => (
  <div
    className={`flex items-center self-center shrink-0 gap-1.5 text-3xs text-wb-text-muted ${
      compensateHeader ? 'mt-[1.375rem]' : ''
    } ${isMe ? 'justify-end' : 'justify-start'}`}
  >
    <button
      type="button"
      onClick={onReply}
      aria-label="回复该消息"
      title="回复该消息"
      className={`relative opacity-0 group-hover:opacity-100 transition-all self-center w-7 h-7 rounded-full bg-wb-bg-subtle hover:bg-wb-info/15 text-wb-text-muted hover:text-wb-info border border-wb-border-subtle flex items-center justify-center before:absolute before:-inset-2 before:content-[''] ${
        active ? 'max-sm:opacity-100' : 'max-sm:opacity-0'
      }`}
    >
      <Reply className={`w-3 h-3 ${isMe ? 'scale-x-[-1]' : ''}`} />
    </button>
    {canRecall && (
      <button
        type="button"
        onClick={onRecall}
        aria-label="撤回该消息"
        title="撤回该消息"
        className={`relative opacity-0 group-hover:opacity-100 transition-all self-center h-7 px-2.5 rounded-full bg-wb-bg-subtle hover:bg-wb-danger/15 text-wb-text-muted hover:text-wb-danger border border-wb-border-subtle font-semibold before:absolute before:-inset-2 before:content-[''] ${
          active ? 'max-sm:opacity-100' : 'max-sm:opacity-0'
        }`}
      >
        撤回
      </button>
    )}
  </div>
);
