/* 站内嵌入只保留官方关卡，自制/分享关卡库不启用；
   提供空实现避免 game.js 中 SokobanUserLevels 未定义报错。 */
window.SokobanUserLevels = {
  getUserLevels: function () { return []; },
  saveUserLevel: function () { return null; },
  deleteUserLevel: function () {},
  decodeLevel: function () { return null; }
};
