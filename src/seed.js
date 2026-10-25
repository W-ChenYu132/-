import { data, mutate } from './db.js';
import { hashPassword } from './auth.js';
import { newId, now } from './util.js';

const DEMO = process.env.SEED_DEMO !== '0';

function makeUser({ username, name, password, role, classIds = [] }) {
  return {
    id: newId(),
    username,
    name,
    password: hashPassword(password),
    role,
    classIds,
    active: true,
    createdAt: now(),
    updatedAt: now(),
  };
}

/** 首次启动时初始化管理员与演示数据 */
export async function seed() {
  const d = data();
  if (d.users.length > 0) return { seeded: false };

  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123456';
  const adminName = process.env.ADMIN_NAME || '系统管理员';

  const admin = makeUser({
    username: adminUsername,
    name: adminName,
    password: adminPassword,
    role: 'admin',
  });

  const users = [admin];
  const classes = [];

  if (DEMO) {
    const classA = { id: newId(), name: '高一(1)班', note: '演示班级', createdBy: admin.id, createdAt: now() };
    const classB = { id: newId(), name: '高一(2)班', note: '演示班级', createdBy: admin.id, createdAt: now() };
    classes.push(classA, classB);

    users.push(
      makeUser({ username: 'teacher', name: '王老师', password: '123456', role: 'teacher' }),
      makeUser({
        username: 'student',
        name: '张三',
        password: '123456',
        role: 'student',
        classIds: [classA.id],
      }),
      makeUser({
        username: 'li',
        name: '李四',
        password: '123456',
        role: 'student',
        classIds: [classA.id],
      }),
      makeUser({
        username: 'wang',
        name: '王五',
        password: '123456',
        role: 'student',
        classIds: [classB.id],
      }),
    );
  }

  await mutate((db) => {
    db.users.push(...users);
    db.classes.push(...classes);
    db.settings = {
      siteName: '云作业',
      registerEnabled: true,
      registerNote: '',
    };

    if (DEMO) {
      const classA = classes[0];
      db.assignments.push({
        id: newId(),
        title: '第 1 次作业：自我介绍',
        content:
          '请用 200 字左右介绍你自己，包含以下信息：\n\n' +
          '1. 姓名、班级；\n' +
          '2. 你的专业方向与兴趣点；\n' +
          '3. 你希望从本课程中学到什么。\n\n' +
          '提示：可以直接在下方输入框作答，也可以上传 Word / 图片作业。',
        deadline: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
        maxScore: 100,
        allowLate: true,
        published: true,
        files: [],
        classIds: [classA.id],
        createdBy: admin.id,
        createdAt: now(),
        updatedAt: now(),
      });
      db.assignments.push({
        id: newId(),
        title: '第 2 次作业：面向全体学生的小测',
        content: '这道题没有设置截止时间，也没有限定班级，所有学生都能看到。\n\n请写下你对这门课的第一个疑问。',
        deadline: null,
        maxScore: 50,
        allowLate: true,
        published: true,
        files: [],
        classIds: [],
        createdBy: admin.id,
        createdAt: now(),
        updatedAt: now(),
      });
    }
  });

  return {
    seeded: true,
    admin: { username: adminUsername, password: adminPassword },
    demo: DEMO,
  };
}
