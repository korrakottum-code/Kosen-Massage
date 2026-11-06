// สร้าง payload QR PromptPay (มาตรฐาน EMVCo / Thai QR Payment) พร้อมฝังยอดเงิน
// รองรับ: เบอร์มือถือ (10 หลัก), เลขบัตรประชาชน/ผู้เสียภาษี (13 หลัก), e-Wallet (15 หลัก)

const tlv = (id, value) => id + String(value.length).padStart(2, '0') + value;

export function crc16(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export function promptPayPayload(target, amount) {
  const digits = String(target || '').replace(/\D/g, '');
  let account;
  if (digits.length >= 15) account = tlv('03', digits);
  else if (digits.length === 13) account = tlv('02', digits);
  else if (digits.length === 10 && digits.startsWith('0')) account = tlv('01', ('0000000000000' + '66' + digits.slice(1)).slice(-13));
  else throw new Error('Invalid PromptPay ID');

  const amt = Number(amount);
  const hasAmount = Number.isFinite(amt) && amt > 0;
  let payload =
    tlv('00', '01') +
    tlv('01', hasAmount ? '12' : '11') +
    tlv('29', tlv('00', 'A000000677010111') + account) +
    tlv('58', 'TH') +
    tlv('53', '764') +
    (hasAmount ? tlv('54', amt.toFixed(2)) : '');
  payload += '6304';
  return payload + crc16(payload);
}
