/** Words on the screens a patient reads (their booking link, the waiting-room TV), in English, Telugu and Hindi. Staff screens stay English. */
export type Lang = 'en' | 'te' | 'hi';
export const LANG_NAMES: [Lang, string][] = [['en', 'English'], ['te', 'తెలుగు'], ['hi', 'हिंदी']];
export const asLang = (x: unknown): Lang => (x === 'te' || x === 'hi' ? x : 'en');

const en = {
  // patient link
  booked: 'You are booked.', keepPage: 'Keep this page: you can come back to it any time.',
  hello: (n: string) => `Hello ${n}, your visit`, visit: 'Visit', withDoctor: (d: string) => ` with ${d}`,
  arriveBy: (t: string) => <>Please arrive by <b>{t}</b>. The wait can be 30–45 minutes.</>,
  yesComing: 'Yes, I will come', change: 'Change day or time', cancelVisit: 'Cancel this visit',
  reason: 'Reason (optional)', reasonEg: 'e.g. feeling better', doCancel: 'Cancel visit', keep: 'Keep it',
  tooLate: (h: number) => `It is less than ${h} hours to your visit. To change it, please call`, theClinic: 'the clinic',
  badLink: 'This link is not valid', badLinkHint: 'It may be old or mistyped. Please call the clinic.',
  moveTo: 'Move your visit to', oldGivenUp: 'Your old time is given up.', move: 'Move', cancel: 'Cancel',
  pickNew: 'Pick a new time', earlier: 'Earlier', later: 'Later', noTimes: 'No free times in these days. Try later days.', back: 'Back',
  status: { booked: 'booked', confirmed: 'confirmed', arrived: 'checked in', cancelled: 'cancelled', no_show: 'missed' } as Record<string, string>,
  // waiting-room TV
  now: 'Now', next: 'Next', waiting: 'Waiting', nobody: 'Nobody is waiting right now.', withJunior: 'With the junior doctor',
  waitForToken: 'Please wait for your token. Reception will send you in.',
  tapSound: 'Tap to turn on sound', chimeHint: 'A chime plays when a new token is called.',
};
type Words = typeof en;

const te: Words = {
  booked: 'మీ అపాయింట్‌మెంట్ బుక్ అయింది.', keepPage: 'ఈ పేజీని ఉంచుకోండి: ఎప్పుడైనా మళ్ళీ చూడవచ్చు.',
  hello: (n) => `నమస్తే ${n} గారు, మీ అపాయింట్‌మెంట్`, visit: 'సంప్రదింపు', withDoctor: (d) => ` · ${d}`,
  arriveBy: (t) => <>దయచేసి <b>{t}</b> లోపు రండి. 30–45 నిమిషాలు వేచి ఉండవలసి రావచ్చు.</>,
  yesComing: 'అవును, నేను వస్తాను', change: 'రోజు లేదా సమయం మార్చండి', cancelVisit: 'ఈ అపాయింట్‌మెంట్ రద్దు చేయండి',
  reason: 'కారణం (ఐచ్ఛికం)', reasonEg: 'ఉదా. ఇప్పుడు బాగానే ఉంది', doCancel: 'రద్దు చేయండి', keep: 'ఉంచండి',
  tooLate: (h) => `మీ అపాయింట్‌మెంట్‌కి ${h} గంటల కంటే తక్కువ సమయం ఉంది. మార్చడానికి దయచేసి ఫోన్ చేయండి:`, theClinic: 'క్లినిక్‌కి',
  badLink: 'ఈ లింక్ పని చేయడం లేదు', badLinkHint: 'ఇది పాతది కావచ్చు లేదా తప్పుగా ఉండవచ్చు. దయచేసి క్లినిక్‌కి ఫోన్ చేయండి.',
  moveTo: 'మీ అపాయింట్‌మెంట్‌ని ఈ సమయానికి మార్చాలా:', oldGivenUp: 'మీ పాత సమయం వదులుకుంటారు.', move: 'మార్చండి', cancel: 'వద్దు',
  pickNew: 'కొత్త సమయం ఎంచుకోండి', earlier: 'ముందు', later: 'తర్వాత', noTimes: 'ఈ రోజుల్లో ఖాళీ సమయాలు లేవు. తర్వాతి రోజులు చూడండి.', back: 'వెనక్కి',
  status: { booked: 'బుక్ అయింది', confirmed: 'నిర్ధారించారు', arrived: 'చెక్-ఇన్ అయింది', cancelled: 'రద్దు అయింది', no_show: 'రాలేదు' },
  now: 'ఇప్పుడు', next: 'తర్వాత', waiting: 'వేచి ఉన్నవారు', nobody: 'ప్రస్తుతం ఎవరూ వేచి లేరు.', withJunior: 'జూనియర్ డాక్టర్ వద్ద',
  waitForToken: 'దయచేసి మీ టోకెన్ కోసం వేచి ఉండండి. రిసెప్షన్ మిమ్మల్ని లోపలికి పంపుతుంది.',
  tapSound: 'సౌండ్ ఆన్ చేయడానికి నొక్కండి', chimeHint: 'కొత్త టోకెన్ పిలిచినప్పుడు గంట మోగుతుంది.',
};

const hi: Words = {
  booked: 'आपका अपॉइंटमेंट बुक हो गया है।', keepPage: 'यह पेज रखें: आप कभी भी इस पर वापस आ सकते हैं।',
  hello: (n) => `नमस्ते ${n} जी, आपका अपॉइंटमेंट`, visit: 'परामर्श', withDoctor: (d) => ` · ${d}`,
  arriveBy: (t) => <>कृपया <b>{t}</b> तक पहुँचें। 30–45 मिनट इंतज़ार करना पड़ सकता है।</>,
  yesComing: 'हाँ, हम आएँगे', change: 'दिन या समय बदलें', cancelVisit: 'यह अपॉइंटमेंट रद्द करें',
  reason: 'कारण (ज़रूरी नहीं)', reasonEg: 'जैसे अब ठीक हूँ', doCancel: 'रद्द करें', keep: 'रहने दें',
  tooLate: (h) => `आपके अपॉइंटमेंट में ${h} घंटे से कम समय है। बदलने के लिए कृपया फ़ोन करें:`, theClinic: 'क्लिनिक को',
  badLink: 'यह लिंक सही नहीं है', badLinkHint: 'यह पुराना या गलत हो सकता है। कृपया क्लिनिक को फ़ोन करें।',
  moveTo: 'अपना अपॉइंटमेंट इस समय पर बदलें:', oldGivenUp: 'आपका पुराना समय छूट जाएगा।', move: 'बदलें', cancel: 'नहीं',
  pickNew: 'नया समय चुनें', earlier: 'पहले', later: 'बाद में', noTimes: 'इन दिनों में कोई खाली समय नहीं है। आगे के दिन देखें।', back: 'वापस',
  status: { booked: 'बुक है', confirmed: 'पक्का', arrived: 'पहुँच गए', cancelled: 'रद्द', no_show: 'नहीं आए' },
  now: 'अभी', next: 'अगला', waiting: 'इंतज़ार में', nobody: 'अभी कोई इंतज़ार में नहीं है।', withJunior: 'जूनियर डॉक्टर के पास',
  waitForToken: 'कृपया अपने टोकन का इंतज़ार करें। रिसेप्शन आपको अंदर भेजेगा।',
  tapSound: 'आवाज़ चालू करने के लिए छुएँ', chimeHint: 'नया टोकन बुलाने पर घंटी बजेगी।',
};

export const WORDS: Record<Lang, Words> = { en, te, hi };
/** A date in the patient's language, numbers as they are. */
export const niceDate = (d: string, lang: Lang) => new Date(d + 'T00:00:00Z').toLocaleDateString(`${lang}-IN`, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
