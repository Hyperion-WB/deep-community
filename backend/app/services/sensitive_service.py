import re
import unicodedata
from typing import List, Tuple, Set

class TrieNode:
    def __init__(self):
        self.children = {}
        self.is_end = False
        self.action = "block" # block / replace / warn

class SensitiveFilter:
    """基于 Trie 树的高性能敏感词匹配器，支持降噪归一化与热重载"""
    def __init__(self):
        self.root = TrieNode()
        # 内置基础保底敏感词
        self.default_bad_words = [
            "法轮功", "办证", "刻章", "代开发票", "枪支弹药", "迷魂药",
            "博彩网站", "赌博平台", "色情直播", "裸聊", "代考"
        ]
        for w in self.default_bad_words:
            self.add_word(w, "block")

    def add_word(self, word: str, action: str = "block"):
        word = word.strip().lower()
        if not word:
            return
        node = self.root
        for char in word:
            if char not in node.children:
                node.children[char] = TrieNode()
            node = node.children[char]
        node.is_end = True
        node.action = action

    def load_words_from_list(self, word_list: List[Tuple[str, str]]):
        """重构 Trie 树（热加载）。

        先在新 Trie 上完整构建，最后一次性替换根节点：
        否则构建期间 root 指向半成品树，并发扫描会漏词。
        """
        new_root = TrieNode()

        def _add(root: TrieNode, word: str, action: str) -> None:
            word = (word or "").strip().lower()
            if not word:
                return
            node = root
            for char in word:
                if char not in node.children:
                    node.children[char] = TrieNode()
                node = node.children[char]
            node.is_end = True
            node.action = action

        for w in self.default_bad_words:
            _add(new_root, w, "block")
        for word, action in word_list:
            _add(new_root, word, action)
        self.root = new_root

    @staticmethod
    def normalize_text(text: str) -> str:
        """
        降噪管道:
        1. 全角字符转半角 (NFKC 归一化)
        2. 去除所有标点符号与特殊干扰字符 (如: "敏*感*词" -> "敏感词")
        """
        if not text:
            return ""
        # NFKC 标准化
        text = unicodedata.normalize('NFKC', text)
        # 转小写
        text = text.lower()
        return text

    def scan(self, text: str) -> Tuple[bool, List[str], str]:
        """
        扫描文本中的敏感词:
        返回 (is_blocked, hit_words, replaced_text)
        """
        if not text:
            return False, [], ""

        normalized = self.normalize_text(text)
        
        # 建立纯净字符索引映射 (用于在原文本中准确定位替换)
        clean_chars = []
        index_map = [] # 记录 clean_char 在原 text 中的真实索引
        for i, ch in enumerate(text):
            # 过滤空格和常见干扰符号
            if not re.match(r'[\s\W_~`!@#$%^&*()+\-=\[\]{};\':"\\|,.<>\/?·！￥…（）—【】、；：‘’“”《》？，。]', ch):
                clean_chars.append(unicodedata.normalize('NFKC', ch).lower())
                index_map.append(i)

        clean_text = "".join(clean_chars)
        n = len(clean_text)
        hit_words = []
        is_blocked = False
        replace_ranges = []

        i = 0
        while i < n:
            node = self.root
            match_len = 0
            curr_action = None

            for j in range(i, n):
                char = clean_text[j]
                if char in node.children:
                    node = node.children[char]
                    if node.is_end:
                        match_len = j - i + 1
                        curr_action = node.action
                else:
                    break

            if match_len > 0:
                matched_word = clean_text[i:i + match_len]
                hit_words.append(matched_word)

                if curr_action == "block":
                    is_blocked = True

                # 记录原文本替换区间
                start_orig = index_map[i]
                end_orig = index_map[i + match_len - 1] + 1
                replace_ranges.append((start_orig, end_orig))

                i += match_len
            else:
                i += 1

        # 构建替换后的文本 (用 *** 替换)
        text_chars = list(text)
        for s, e in replace_ranges:
            for k in range(s, e):
                text_chars[k] = '*'
        replaced_text = "".join(text_chars)

        return is_blocked, hit_words, replaced_text

sensitive_filter = SensitiveFilter()
