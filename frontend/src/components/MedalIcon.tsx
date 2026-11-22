import React from 'react';
import {
  Award,
  Bomb,
  BookOpen,
  Bug,
  Calendar,
  Circle,
  Code2,
  Coffee,
  Compass,
  Copy,
  DoorOpen,
  Gamepad2,
  Handshake,
  Heart,
  Layers,
  MessageSquare,
  Moon,
  PenLine,
  Pointer,
  Printer,
  RefreshCw,
  Rocket,
  Satellite,
  Scroll,
  Sparkles,
  Target,
  Terminal,
  Trophy,
  Users,
} from 'lucide-react';

/** 勋章图标统一走线性图标，不使用 emoji（风格更克制，也更像产品而不是生成内容） */
const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  pen: PenLine,
  heart: Heart,
  calendar: Calendar,
  users: Users,
  message: MessageSquare,
  book: BookOpen,
  code: Code2,
  moon: Moon,
  compass: Compass,
  award: Award,
  rocket: Rocket,
  sparkles: Sparkles,
  target: Target,
  scroll: Scroll,
  handshake: Handshake,
  bug: Bug,
  layers: Layers,
  satellite: Satellite,
  pointer: Pointer,
  gamepad: Gamepad2,
  bomb: Bomb,
  refresh: RefreshCw,
  circle: Circle,
  trophy: Trophy,
  // 特殊图标
  terminal: Terminal,
  printer: Printer,
  copy: Copy,
  coffee: Coffee,
  door: DoorOpen,
};

export const MEDAL_ICON_KEYS = Object.keys(ICON_MAP);

export const MedalIcon: React.FC<{ name?: string; className?: string }> = ({
  name,
  className = 'w-4 h-4',
}) => {
  const Component = (name && ICON_MAP[name]) || Trophy;
  return <Component className={className} />;
};
