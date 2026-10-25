/**
 * 命令行重置任意账号的密码（忘记管理员密码时使用）
 * 用法：node scripts/reset-password.mjs <用户名> <新密码>
 */

import { data, mutate } from '../src/db.js';
import { hashPassword } from '../src/auth.js';

const [username, newPassword] = process.argv.slice(2);

if (!username || !newPassword) {
  console.log('用法：node scripts/reset-password.mjs <用户名> <新密码>');
  process.exit(1);
}

if (newPassword.length < 6) {
  console.log('新密码至少 6 位');
  process.exit(1);
}

const user = data().users.find((u) => u.username.toLowerCase() === username.toLowerCase());
if (!user) {
  console.log(`未找到用户：${username}`);
  console.log('现有账号：', data().users.map((u) => `${u.username}(${u.role})`).join(', '));
  process.exit(1);
}

await mutate((db) => {
  const u = db.users.find((x) => x.id === user.id);
  u.password = hashPassword(newPassword);
  u.updatedAt = new Date().toISOString();
});

console.log(`✅ 已将 ${username}（${user.name}）的密码重置为：${newPassword}`);
