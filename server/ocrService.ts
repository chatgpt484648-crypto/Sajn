import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import type { OcrExtractionPayload } from '../src/types/mirror.ts';

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Screenshot OCR requires GEMINI_API_KEY. For zero-key live sync every 4 seconds, use Connect Account on the Home tab.',
    );
  }

  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

const OCR_SYSTEM_INSTRUCTION = `You are a high-precision OCR extractor for the TechSMS web dashboard (techsms.org/dashboard, My Numbers, View All Records / CDR SMS logs).
Your job is to transcribe whichever account is currently logged in, ALL visible allocated numbers from My Numbers, and ALL visible inbound SMS rows character-for-character into structured JSON.

Rules:
1. Extract accountName from "Welcome back, <Name>" or any visible account/profile header (e.g. "Ahmad Amir"). If no account name is visible on the current sub-page (such as My Numbers), return "".
2. Extract accountStatus (e.g. "Operational · Full Access" or "Operational") if visible, otherwise "".
3. Extract activeNumbersCount from the "ACTIVE NUMBERS" card as an integer. If on the "My Numbers" page without a KPI card, set activeNumbersCount to the count of extracted rows in activeNumbers[]; if not visible at all, return -1.
4. Extract todaysSmsCount from the "TODAY'S SMS RECEIVED" card as an integer. If not visible, return -1.
5. If a "My Numbers" or Active Numbers table is visible, extract EVERY SINGLE visible row into activeNumbers[]:
   - number: exact phone number including '+' (e.g. "+447378178426")
   - country: inferred country (e.g. "United Kingdom")
   - service: range or service name (e.g. "United Kingdom S08 TSMS (Exclusive)")
   - range: exact RANGE column text
   - term: exact TERM column text (e.g. "30/15")
   - allocatedAt: exact ALLOCATED AT column text (e.g. "2026-11-15")
   - expiresAt: exact EXPIRES AT column text (e.g. "2026-11-29 23:41")
   - status: "Active"
   Do NOT duplicate SMS inbound rows into activeNumbers unless there is an explicit My Numbers / Active Numbers table.
6. Extract ALL visible rows from "Recent SMS Inbound", "All Records", or any SMS messages table into messages[]:
   - time: exact timestamp string (e.g. "2026-11-15T21:25:03")
   - destination: exact destination phone number including '+' (e.g. "+447868242430")
   - senderId: exact sender string (e.g. "1xbet.com", "eBay")
   - message: exact message body
   - otpCode: extract any numeric/alphanumeric verification code (4 to 8 digits) inside the message, or "" if none.
7. STRICTLY IGNORE AND DO NOT INCLUDE any financial, payout, balance, or rate columns (such as "TODAY'S PAYOUT", "$0.0000", "RATE", "$0.0025"). Never place monetary amounts in any output field.
8. Never invent or guess rows that are not clearly legible in the image.`;

export async function runDashboardOcr(
  base64Image: string,
  mimeType: string,
): Promise<OcrExtractionPayload> {
  const ai = getGeminiClient();

  const cleanBase64 = base64Image.includes(',')
    ? base64Image.split(',')[1]
    : base64Image;

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: {
      parts: [
        {
          inlineData: {
            mimeType: mimeType || 'image/png',
            data: cleanBase64,
          },
        },
        {
          text: 'Read this TechSMS image via OCR and extract EVERY visible row from My Numbers and/or Recent SMS Inbound (excluding all payout and rate figures).',
        },
      ],
    },
    config: {
      systemInstruction: OCR_SYSTEM_INSTRUCTION,
      thinkingConfig: {
        thinkingLevel: ThinkingLevel.LOW,
      },
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          detectedSource: {
            type: Type.STRING,
            description: 'Detected page or platform name, e.g. techsms.org/my-numbers',
          },
          accountName: {
            type: Type.STRING,
            description: 'Account holder name shown on the welcome banner, or empty string.',
          },
          accountStatus: {
            type: Type.STRING,
            description: 'Account operational status text if visible, or empty string.',
          },
          activeNumbersCount: {
            type: Type.INTEGER,
            description: 'Integer count shown on ACTIVE NUMBERS card or number of active rows, or -1 if not visible.',
          },
          todaysSmsCount: {
            type: Type.INTEGER,
            description: 'Integer count shown on TODAYS SMS RECEIVED card, or -1 if not visible.',
          },
          activeNumbers: {
            type: Type.ARRAY,
            description: 'Explicit active numbers list from My Numbers table.',
            items: {
              type: Type.OBJECT,
              properties: {
                number: { type: Type.STRING },
                country: { type: Type.STRING },
                service: { type: Type.STRING },
                range: { type: Type.STRING },
                term: { type: Type.STRING },
                allocatedAt: { type: Type.STRING },
                expiresAt: { type: Type.STRING },
                status: { type: Type.STRING },
              },
              required: ['number', 'country', 'service', 'status'],
            },
          },
          messages: {
            type: Type.ARRAY,
            description: 'Inbound SMS rows excluding rate/payout columns.',
            items: {
              type: Type.OBJECT,
              properties: {
                time: { type: Type.STRING },
                destination: { type: Type.STRING },
                senderId: { type: Type.STRING },
                message: { type: Type.STRING },
                otpCode: { type: Type.STRING },
              },
              required: ['time', 'destination', 'senderId', 'message', 'otpCode'],
            },
          },
        },
        required: [
          'detectedSource',
          'accountName',
          'accountStatus',
          'activeNumbersCount',
          'todaysSmsCount',
          'activeNumbers',
          'messages',
        ],
      },
    },
  });

  const rawText = (response.text ?? '{}').trim();
  const parsed = JSON.parse(rawText) as OcrExtractionPayload;
  return {
    detectedSource: parsed.detectedSource || 'techsms.org/dashboard',
    accountName: parsed.accountName || '',
    accountStatus: parsed.accountStatus || '',
    activeNumbersCount:
      typeof parsed.activeNumbersCount === 'number' ? parsed.activeNumbersCount : -1,
    todaysSmsCount:
      typeof parsed.todaysSmsCount === 'number' ? parsed.todaysSmsCount : -1,
    activeNumbers: Array.isArray(parsed.activeNumbers) ? parsed.activeNumbers : [],
    messages: Array.isArray(parsed.messages) ? parsed.messages : [],
  };
}
