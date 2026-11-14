/** Words a patient reads (WhatsApp), in English, Telugu and Hindi. Staff screens stay English. Numbers, times and names are kept as they are. */
export const LANGS = ['en', 'te', 'hi'] as const;
export type Lang = (typeof LANGS)[number];
const isLang = (x: unknown): x is Lang => (LANGS as readonly unknown[]).includes(x);

/** The patient's own language if set, else the clinic's default for patients, else English. Reads `language` defensively: the column may not exist yet. */
export function patientLang(p: unknown, settings: any): Lang {
  const own = (p as any)?.language;
  if (isLang(own)) return own;
  const def = settings?.messages?.language;
  return isLang(def) ? def : 'en';
}

type Kind = 'confirmation' | 'reminder' | 'moved' | 'cancelled' | 'late' | 'reschedule';
/** Booking messages in Telugu and Hindi. English lives in booking.ts (the clinic may edit that text). */
export const TRANSLATED_TEMPLATES: Record<'te' | 'hi', Record<Kind, string>> = {
  te: {
    confirmation: 'నమస్తే {patient} గారు, {clinic} లో {doctor} వద్ద మీ అపాయింట్‌మెంట్ ({visitType}) {date}, {time} కి బుక్ అయింది. దయచేసి {arriveBy} లోపు రండి. నిర్ధారించడానికి, రద్దు చేయడానికి లేదా మార్చడానికి: {link}',
    reminder: 'గుర్తు చేస్తున్నాం: {date}, {time} కి {clinic} లో మీ అపాయింట్‌మెంట్ ({visitType}) ఉంది. దయచేసి {arriveBy} లోపు రండి. నిర్ధారించడానికి లేదా రద్దు చేయడానికి: {link}',
    moved: 'నమస్తే {patient} గారు, {clinic} లో మీ అపాయింట్‌మెంట్ ఇప్పుడు {date}, {time} కి {doctor} వద్ద ఉంది. {arriveBy} లోపు రండి. వివరాలు: {link}',
    cancelled: 'నమస్తే {patient} గారు, {date}, {time} కి {clinic} లో మీ అపాయింట్‌మెంట్ రద్దు అయింది. మళ్ళీ బుక్ చేయడానికి మాకు ఫోన్ చేయండి.',
    late: 'నమస్తే {patient} గారు, ఈ రోజు {clinic} లో {doctor} సుమారు {minutes} నిమిషాలు ఆలస్యంగా ఉన్నారు. మీ {time} అపాయింట్‌మెంట్ కొంచెం ఆలస్యంగా మొదలవుతుంది. ఎదురుచూపుకు క్షమించండి.',
    reschedule: 'నమస్తే {patient} గారు, {date}, {time} కి {clinic} లో మీ అపాయింట్‌మెంట్‌కి {doctor} అందుబాటులో లేరు. {reason} దయచేసి వేరే సమయం ఎంచుకోండి: {link}',
  },
  hi: {
    confirmation: 'नमस्ते {patient} जी, {clinic} में {doctor} के साथ आपका अपॉइंटमेंट ({visitType}) {date}, {time} पर बुक हो गया है। कृपया {arriveBy} तक पहुँचें। पक्का करने, रद्द करने या बदलने के लिए: {link}',
    reminder: 'याद दिला रहे हैं: {clinic} में आपका अपॉइंटमेंट ({visitType}) {date}, {time} पर है। कृपया {arriveBy} तक पहुँचें। पक्का करने या रद्द करने के लिए: {link}',
    moved: 'नमस्ते {patient} जी, {clinic} में आपका अपॉइंटमेंट अब {date}, {time} पर {doctor} के साथ है। {arriveBy} तक पहुँचें। जानकारी: {link}',
    cancelled: 'नमस्ते {patient} जी, {clinic} में {date}, {time} का आपका अपॉइंटमेंट रद्द हो गया है। फिर से बुक करने के लिए हमें फ़ोन करें।',
    late: 'नमस्ते {patient} जी, आज {clinic} में {doctor} लगभग {minutes} मिनट देर से चल रहे हैं। आपका {time} का अपॉइंटमेंट थोड़ी देर से शुरू होगा। इंतज़ार के लिए माफ़ कीजिए।',
    reschedule: 'नमस्ते {patient} जी, {date}, {time} पर {clinic} में आपके अपॉइंटमेंट के लिए {doctor} उपलब्ध नहीं हैं। {reason} कृपया कोई और समय चुनें: {link}',
  },
};

/** Stand-ins when a booking has no doctor or no visit type. */
export const FALLBACK: Record<Lang, { doctor: string; visitType: string }> = {
  en: { doctor: 'the doctor', visitType: 'visit' },
  te: { doctor: 'డాక్టర్', visitType: 'సంప్రదింపు' },
  hi: { doctor: 'डॉक्टर', visitType: 'परामर्श' },
};

/** The other patient messages: a missed follow-up call, the prescription, a quote, the pharmacy bill. */
export const MSG = {
  en: {
    triedToCall: (first: string, clinic: string, phone?: string) => `Hello ${first}, we tried to reach you from ${clinic}. ${phone ? `Please call ${phone} or ` : 'Please '}reply to this message and we will help you.`,
    rxFor: (clinic: string, name: string) => `${clinic}: prescription for ${name}.`, medicines: 'Medicines', howToUse: 'How to use', reviewOn: (d: string) => `Review on ${d}.`, questions: (p: string) => `Questions? Call ${p}.`,
    quote: 'Quote', plan: 'Your treatment plan', sittings: 'sittings', total: 'Total', validUntil: (d: string) => `Valid until ${d}.`, replyYes: 'Reply YES to book your first session.',
    pharmacyBill: 'Pharmacy bill', gstIncluded: '(GST included)',
    sittingReminder: (first: string, proc: string, part: string, date: string, time: string, clinic: string, phone?: string) => `Hello ${first}, a reminder from ${clinic}: your ${proc} session${part ? ` (${part})` : ''} is tomorrow, ${date} at ${time}. ${phone ? `To change it, please call ${phone}.` : 'To change it, reply to this message.'}`,
  },
  te: {
    triedToCall: (first: string, clinic: string, phone?: string) => `నమస్తే ${first} గారు, ${clinic} నుండి మీకు ఫోన్ చేశాము. ${phone ? `దయచేసి ${phone} కి ఫోన్ చేయండి లేదా ` : 'దయచేసి '}ఈ మెసేజ్‌కి రిప్లై ఇవ్వండి, మేము సహాయం చేస్తాము.`,
    rxFor: (clinic: string, name: string) => `${clinic}: ${name} గారికి ప్రిస్క్రిప్షన్.`, medicines: 'మందులు', howToUse: 'ఎలా వాడాలి', reviewOn: (d: string) => `మళ్ళీ చూపించుకోవలసిన తేదీ: ${d}.`, questions: (p: string) => `సందేహాలుంటే ${p} కి ఫోన్ చేయండి.`,
    quote: 'కొటేషన్', plan: 'మీ చికిత్స ప్లాన్', sittings: 'సిట్టింగ్‌లు', total: 'మొత్తం', validUntil: (d: string) => `${d} వరకు చెల్లుతుంది.`, replyYes: 'మొదటి సిట్టింగ్ బుక్ చేయడానికి YES అని రిప్లై ఇవ్వండి.',
    pharmacyBill: 'ఫార్మసీ బిల్', gstIncluded: '(GST కలిపి)',
    sittingReminder: (first: string, proc: string, part: string, date: string, time: string, clinic: string, phone?: string) => `నమస్తే ${first} గారు, ${clinic} నుండి గుర్తు: మీ ${proc} సిట్టింగ్${part ? ` (${part})` : ''} రేపు, ${date} ${time} కి ఉంది. ${phone ? `మార్చాలంటే దయచేసి ${phone} కి ఫోన్ చేయండి.` : 'మార్చాలంటే ఈ మెసేజ్‌కి రిప్లై ఇవ్వండి.'}`,
  },
  hi: {
    triedToCall: (first: string, clinic: string, phone?: string) => `नमस्ते ${first} जी, हमने ${clinic} से आपको फ़ोन किया था। ${phone ? `कृपया ${phone} पर फ़ोन करें या ` : 'कृपया '}इस मैसेज का जवाब दें, हम आपकी मदद करेंगे।`,
    rxFor: (clinic: string, name: string) => `${clinic}: ${name} के लिए पर्चा।`, medicines: 'दवाइयाँ', howToUse: 'कैसे इस्तेमाल करें', reviewOn: (d: string) => `दोबारा दिखाने की तारीख: ${d}।`, questions: (p: string) => `कोई सवाल हो तो ${p} पर फ़ोन करें।`,
    quote: 'कोटेशन', plan: 'आपका इलाज प्लान', sittings: 'सिटिंग', total: 'कुल', validUntil: (d: string) => `${d} तक मान्य।`, replyYes: 'पहली सिटिंग बुक करने के लिए YES लिखकर जवाब दें।',
    pharmacyBill: 'फ़ार्मेसी बिल', gstIncluded: '(GST सहित)',
    sittingReminder: (first: string, proc: string, part: string, date: string, time: string, clinic: string, phone?: string) => `नमस्ते ${first} जी, ${clinic} से याद दिलाना: आपकी ${proc} सिटिंग${part ? ` (${part})` : ''} कल, ${date} को ${time} बजे है। ${phone ? `बदलने के लिए कृपया ${phone} पर फ़ोन करें।` : 'बदलने के लिए इस मैसेज का जवाब दें।'}`,
  },
} satisfies Record<Lang, unknown>;
