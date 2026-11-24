
// Appended to the original 1.2.3 Computer settings module; $e, Y, Ue and K are its
// section, row, button and type styles. The Host page manages the Bot's computer.
function GrokRemoteDesktop() {
  return (0, Q.jsx)($e, { anchorId: 'outside-settings', title: grokText('远程桌面', 'Remote desktop'), children: (0, Q.jsx)(Y, {
    anchorId: null, label: grokText('Bot 的运行环境', 'Where your Bot runs'), variant: 'card',
    children: (0, Q.jsx)(Ue, { onClick: () => window.localBot.openManagement(), size: 'md', style: K.body2, type: 'button', variant: 'secondary', children: grokText('管理', 'Manage') }),
  }) });
}
