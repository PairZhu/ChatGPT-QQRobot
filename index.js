import fs from 'fs';
import ws from "ws";
import dotenv from 'dotenv';
import fetch from "node-fetch";
import { Low, JSONFile } from 'lowdb';
import { ChatGPTAPI } from 'chatgpt';

dotenv.config();

const masterQQId = process.env.masterQQId;
const wsUrl = process.env.wsUrl;
const httpUrl = process.env.httpUrl;

if (!fs.existsSync('./data')){
    fs.mkdirSync('./data');
}

const adapter = new JSONFile("./data/db.json");
const db = new Low(adapter);
await db.read();
db.data ||= {};

let robotInfo = {};
let chatGPT = null;
let wsClient = null;

// 用对象存储不同人的对话信息
const gptUserData = {};

const connectedClient = async url => {
  const wsResult = client => new Promise((resolve) => {
    const onSuccess = () => {
      client.off('open', onSuccess);
      client.off('error', onError);
      resolve(true);
    }
    const onError = () => {
      client.off('open', onSuccess);
      client.off('error', onError);
      resolve(false);
    }
    client.on('error', onError);
    client.on('open', onSuccess);
  })
  while (true) {
    const client = new ws(url);
    const state = await wsResult(client);
    if (state) {
      return client;
    } else {
      client.terminate();
    }
  }
}

const sendPrivate = (str, QQId = masterQQId) => {
  wsClient.send(JSON.stringify({
    action: 'send_private_msg',
    params: {
      user_id: QQId,
      message: str,
    }
  }));
}

const sendGroup = (str, QQId) => {
  wsClient.send(JSON.stringify({
    action: 'send_group_msg',
    params: {
      group_id: QQId,
      message: str,
    }
  }));
}

const initRobot = async () => {
  const res = await fetch(`${httpUrl}/get_login_info`);
  const { data } = await res.json();
  robotInfo = data;
}

const decodeMsg = str => {
  const reg = /&#([\d]+);/g;
  return str.replaceAll(reg, (_, val) => String.fromCharCode(val)).replaceAll('&amp;', '&');
}

const initChatGPT = async () => {
  if (db.data.gptToken) {
    chatGPT = new ChatGPTAPI({ sessionToken: db.data.gptToken });
    try {
      await chatGPT.ensureAuth();
      sendPrivate('chatGPT初始化成功！');
    } catch (error) {
      sendPrivate('无效的token：' + error);
      chatGPT = null;
    }
  } else {
    sendPrivate('chatGPT未设置Token\n请发送/gpt token <token>设置Token');
  }
}

const gptDealMessage = async ({
  message,
  message_id,
  message_type,
  user_id,
  group_id,
}) => {
  // 如果不是私聊消息且不是群消息，不处理
  if (message_type !== 'private' && message_type !== 'group') return;

  // 如果是群消息，必须要以@机器人开头才处理，并且去除@机器人的部分
  if (message_type === 'group') {
    if (!message.startsWith(`[CQ:at,qq=${robotInfo.user_id}]`)) return;
    message = message.replace(`[CQ:at,qq=${robotInfo.user_id}]`, '').replace(/^ /, '');
  }

  // userKey是对话的唯一标识，一个私聊用户单独一个对话，一个群内的所有人共用一个对话
  const userKey = message_type === 'group' ? 'g_' + group_id : 'p_' + user_id;
  // 定义常用的数据为局部变量，方便后面使用
  const currentUser = gptUserData[userKey];
  const replyCode = `[CQ:reply,id=${message_id}]`
  const [_matchStr, command, args] = /^(\S+) *(.*)/.exec(decodeMsg(message)) || [];

  // 定义消息发送函数根据是群消息还是私聊消息，选择不同的回复方式
  const sendUserMessage = msg => {
    if (message_type === 'private') {
      sendPrivate(msg, user_id);
    } else {
      sendGroup(msg, group_id);
    }
  }

  // chatGPT命令处理
  if (message.startsWith('/gpt')) {
    // 处理/gpttoken命令
    if (command === '/gpttoken' && args) {
      // 判断是否是机器人的主人
      if (user_id !== masterQQId) {
        sendUserMessage('你不是机器人的主人，无法设置Token');
        return;
      }
      db.data.gptToken = args;
      db.write();
      initChatGPT();
      return;
    }
    // 如果chatGPT还没初始化，
    if (!chatGPT) {
      sendUserMessage('chatGPt还未初始化，请先联系管理员设置Token');
      return;
    }
    // 处理其它命令
    switch (command) {
      case '/gptstart':
        console.log('start('+userKey+')');
        gptUserData[userKey] = {
          timeout: currentUser ? currentUser.timeout : 100,
          conversation: chatGPT.getConversation(),
        };
        sendUserMessage('已创建新的对话，可以开始聊天了');
        return;
      case '/gptend':
        console.log('end('+userKey+')');
        delete gptUserData[userKey];
        sendUserMessage('对话已结束');
        return;
      case '/gpttimeout':
        if (!currentUser) {
          sendUserMessage('还没有发起对话，请输入/gptstart发起对话后重试');
          return;
        }
        if (!args) {
          sendUserMessage(`当前对话超时时间为${currentUser.timeout}秒`);
          return;
        }
        const timeout = parseInt(args);
        if (timeout > 0) {
          currentUser.timeout = timeout;
          sendUserMessage(`已设置对话超时时间为${timeout}秒`);
        } else {
          sendUserMessage('超时时间必须大于0');
        }
        return;
      case '/gpthelp':
        sendUserMessage(`chatGPT命令帮助：\n/gptstart 开始对话\n/gptend 结束对话\n/gptretry 重答上一条问题\n/gpttimeout <秒数> 设置对话超时时间，不填写秒数则显示当前超时时间\n/gpttoken <token> 设置chatGPT的Token，只有机器人主人才能设置`);
        return;
      case '/gptretry':
        if (!currentUser) {
          sendUserMessage('还没有发起对话，请先输入/gptstart发起对话');
          return;
        }
        if (!currentUser.previousMessage) {
          sendUserMessage('当前对话还没有消息，无法重答');
          return;
        }
        // 如果可以重答，那么移交给下面发送问题的逻辑处理
        break;
      default:
        sendUserMessage('未知的chatGPT命令，请输入/gpthelp查看帮助');
        return;
    }
  }

  // 如果chatGPT还没初始化，不处理
  if (!chatGPT) return;
  // 如果消息发送者没有对话，那么不处理
  if (!currentUser) return;
  // 如果当前会话正忙，则提示，不处理
  if (currentUser.busy) {
    sendUserMessage(replyCode + '请等上一条消息回答完毕。\n若想放弃等待重新开始会话可输入/gptstart\n若想看所有命令请输入/gpthelp');
    return;
  }
  // 标记会话为忙
  currentUser.busy = true;

  // 发送消息给GPT
  console.log('message(' + userKey + '): ' + message);
  try {
    let userMessage = message;
    // 判断是否是重答的命令
    if (command === '/gptretry') {
      userMessage = currentUser.previousMessage;
      // 如果只发了一条消息，那么直接重开对话
      if (!currentUser.previousParentMessageId) {
        currentUser.conversation = chatGPT.getConversation();
      } else {
        currentUser.conversation.parentMessageId = currentUser.previousParentMessageId;
      }
    } else {
      currentUser.previousMessage = message;
      currentUser.previousParentMessageId = currentUser.conversation.parentMessageId;
    }
    const reply = await currentUser.conversation.sendMessage(userMessage, {
      timeoutMs: currentUser.timeout * 1000,
    });
    
    // 如果会话仍有效，发送GPT的回复
    console.log('reply(' + userKey + '): ' + reply);
    if (currentUser === gptUserData[userKey]) {
      sendUserMessage(replyCode + reply);
    }
  } catch (error) {
    switch (error.message) {
      case 'ChatGPT timed out waiting for response':
        sendUserMessage('AI超时了，若认为超时时间太短可输入/gpttimeout <秒数> 来设置对话的超时时间\n输入/gptretry重试此问题');
        break;
      default:
        sendUserMessage(`AI出错了：${error.message}\n输入/gptretry重试此问题\n若持续发生错误请尝试/gptstart重新开始会话`);
        sendPrivate('chatGPT错误信息：' + error);
        console.error(error);
    }
  } finally {
    // 标记会话为空闲
    if (currentUser) currentUser.busy = false;
  }
}

const dealMessage = async data => {
  data = JSON.parse(data);
  if (!data.message) return;

  gptDealMessage(data);
}

console.log("正在连接cq-http……");
wsClient = await connectedClient(wsUrl);
console.log("连接成功！");

await initRobot();

wsClient.on("close", () => {
  console.log("连接已断开！")
});
wsClient.on("error", error => {
  console.error("发生错误：", error)
});
wsClient.on("message", dealMessage);

initChatGPT();

// 每小时刷新一次token
setInterval(async () => {
  try {
    if (!chatGPT) return;
    await chatGPT.ensureAuth();
  } catch (error) {
    sendPrivate('chatGPT Token失效');
    console.error(error);
    chatGPT = null;
  }
}, 1*60*60*1000);