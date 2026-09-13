export const DODO_MESSAGES = {
  vi: {
    idle: ['Dodo vẫn ở đây nè.', 'Đang làm gì đó?', 'Hmm...'],
    click: ['Ủa, gọi Dodo hả? 👀', 'Có chuyện gì nè?', 'Dodo nghe!'],
    thinking: ['Để Dodo nghĩ...', 'Hmm...', 'Khoan, Dodo suy nghĩ xíu.'],
    listening: ['Dodo nghe nè.', 'Ừm, kể tiếp đi.', 'Dodo đang nghe.'],
    happy: ['hehe 🐧', 'Yay!', 'Dodo vui quá!'],
    angry: ['Ê, nhẹ tay nha 😤', 'Dodo tự đi được mà!', 'Hừm... bắt được Dodo rồi đó!'],
    dragged: ['Ủa, kéo Dodo đi đâu vậy? 👀', 'Đổi chỗ mới hả?', 'hehe, chỗ này cũng được!'],
  },
};

export function getDodoMessage(category, locale = 'vi') {
  const messages = DODO_MESSAGES[locale]?.[category] || DODO_MESSAGES.vi.idle;
  return messages[Math.floor(Math.random() * messages.length)];
}
