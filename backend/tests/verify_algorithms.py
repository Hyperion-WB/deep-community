import unicodedata
import re
import zlib
import uuid

# 1. 敏惑词 Trie 树测试
class TrieNode:
    def __init__(self):
        self.children = {}
        self.is_end = False

class MiniSensitiveFilter:
    def __init__(self):
        self.root = TrieNode()
        for w in ["办证", "赌博平台"]:
            self.add_word(w)

    def add_word(self, word):
        node = self.root
        for char in word:
            if char not in node.children:
                node.children[char] = TrieNode()
            node = node.children[char]
        node.is_end = True

    def scan(self, text):
        clean_chars = []
        for ch in text:
            if not re.match(r'[\s\W_~`!@#$%^&*()+\-=\[\]{};\':"\\|,.<>\/?·！￥…（）—【】、；：‘’“”《》？，。]', ch):
                clean_chars.append(unicodedata.normalize('NFKC', ch).lower())
        clean_text = "".join(clean_chars)
        n = len(clean_text)
        hits = []
        i = 0
        while i < n:
            node = self.root
            match_len = 0
            for j in range(i, n):
                if clean_text[j] in node.children:
                    node = node.children[clean_text[j]]
                    if node.is_end:
                        match_len = j - i + 1
                else:
                    break
            if match_len > 0:
                hits.append(clean_text[i:i + match_len])
                i += match_len
            else:
                i += 1
        return len(hits) > 0, hits

# 2. 匿名别名测试
def generate_alias(post_id, user_id, is_author=False):
    if is_author:
        seed = f"{post_id}:{user_id}:author"
        suffix = zlib.crc32(seed.encode()) % 100
        return f"匿名楼主#{suffix:02d}"
    seed = f"{post_id}:{user_id}"
    suffix = zlib.crc32(seed.encode()) % 100
    return f"神秘雪豹#{suffix:02d}"

# 执行断言
f = MiniSensitiveFilter()
blocked, hits = f.scan("这里有办证和赌*博-平*台！")
assert blocked and "赌博平台" in hits and "办证" in hits
print("✓ 敏感词降噪与对抗测试通过！")

p1, p2, u = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
assert generate_alias(p1, u) == generate_alias(p1, u)
assert "匿名楼主" in generate_alias(p1, u, True)
print("✓ 匿名别名规则测试通过！")
print("=== 独立单元逻辑自检全部通过！ ===")
