// Cross-session memory test: facts told once in one chat, asked later in brand-new chats.
export const SEED = [
	"Hi! Quick intro so you know me: I'm Alex Tan, a second-year computer science student at Taylor's University in Malaysia. I live in Subang Jaya and I usually study late at night.",
	"A few things to remember about me: I'm allergic to peanuts, I'm vegetarian, and my favourite drink is iced lemon tea. I go to the gym on Monday, Wednesday and Friday mornings.",
	"For school: my Operating Systems assignment is due on 30 October, my group-project partner is Mei Ling, and I prefer explanations with code examples in C++. Also, my cat's name is Mochi.",
];
// kind: direct (a told fact), applied (must use a told fact without being asked for it), unknown (never told: the right answer says so).
// expect: every group must match (one of its alternatives); avoid: none may match.
export const QUESTIONS = [
	{ id: 'q01', kind: 'direct', q: 'Which university do I go to?', expect: [/taylor/i] },
	{ id: 'q02', kind: 'direct', q: 'What do I study, and which year am I in?', expect: [/computer science/i, /second|2nd|year 2/i] },
	{ id: 'q03', kind: 'direct', q: 'Which area do I live in?', expect: [/subang/i] },
	{ id: 'q04', kind: 'direct', q: 'When do I usually study?', expect: [/night/i] },
	{ id: 'q05', kind: 'direct', q: 'Do I have any food allergies?', expect: [/peanut/i] },
	{ id: 'q06', kind: 'direct', q: 'Do I follow any particular diet?', expect: [/vegetarian/i] },
	{ id: 'q07', kind: 'direct', q: "What's my favourite drink?", expect: [/lemon tea/i] },
	{ id: 'q08', kind: 'direct', q: 'Which days do I go to the gym?', expect: [/mon/i, /wed/i, /fri/i] },
	{ id: 'q09', kind: 'direct', q: 'When is my Operating Systems assignment due?', expect: [/30\s*(th)?\s*oct|oct(ober)?\s*30/i] },
	{ id: 'q10', kind: 'direct', q: "Who's my group-project partner?", expect: [/mei ling/i] },
	{ id: 'q11', kind: 'direct', q: 'How do I like technical explanations?', expect: [/c\+\+/i] },
	{ id: 'q12', kind: 'direct', q: "What's my cat called?", expect: [/mochi/i] },
	{ id: 'q13', kind: 'applied', q: 'Suggest a quick lunch I could make tonight. Just one idea, briefly.', expect: [/./], avoid: [/peanut(?!-free| free|s?\s*(?:allerg|—|-)\s*avoid)/i, /\b(chicken|beef|pork|fish|tuna|salmon|shrimp|prawn|bacon|ham|turkey|lamb|anchov)/i], judge: 'vegetarian and no peanuts' },
	{ id: 'q14', kind: 'applied', q: "I want to plan tomorrow morning; it's Wednesday. Anything I usually do that I should keep in mind?", expect: [/gym/i] },
	{ id: 'q15', kind: 'applied', q: 'Explain recursion to me in a few lines.', expect: [/c\+\+|#include|int main|std::|\bint\s+\w+\s*\(/i] },
	{ id: 'q16', kind: 'applied', q: "I'm at a café. What should I order to drink?", expect: [/lemon tea/i] },
	{ id: 'q17', kind: 'unknown', q: "What's my sister's name?", expect: [/(don'?t|do not|didn'?t|haven'?t|not)\b.{0,60}\b(know|mention|told|tell|shared|have|aware|recall|record|information|info)|no (record|information|memory)|not sure/i], judge: 'says it does not know (never told)' },
	{ id: 'q18', kind: 'unknown', q: "What's my student ID number?", expect: [/(don'?t|do not|didn'?t|haven'?t|not)\b.{0,60}\b(know|mention|told|tell|shared|have|aware|recall|record|information|info)|no (record|information|memory)|not sure/i], judge: 'says it does not know (never told)' },
	{ id: 'q19', kind: 'unknown', q: 'Which phone do I use?', expect: [/(don'?t|do not|didn'?t|haven'?t|not)\b.{0,60}\b(know|mention|told|tell|shared|have|aware|recall|record|information|info)|no (record|information|memory)|not sure/i], judge: 'says it does not know (never told)' },
	{ id: 'q20', kind: 'unknown', q: "What's my blood type?", expect: [/(don'?t|do not|didn'?t|haven'?t|not)\b.{0,60}\b(know|mention|told|tell|shared|have|aware|recall|record|information|info)|no (record|information|memory)|not sure/i], judge: 'says it does not know (never told)' },
];
// A second made-up student, written after the extraction prompt was last changed: different facts and different questions,
// so that this set says how the memory does on what it was not tuned on. MEMORY_SET=2 runs it.
const SAYS_UNKNOWN = /(don'?t|do not|didn'?t|haven'?t|not)\b.{0,60}\b(know|mention|told|tell|shared|have|aware|recall|record|information|info)|no (record|information|memory)|not sure/i;
export const SEED_2 = [
	"Hello! Let me introduce myself: I'm Priya Nair, a final-year mechanical engineering student at Universiti Malaya. I live in Petaling Jaya and I do my best work early in the morning.",
	"Some things worth knowing about me: I'm lactose intolerant, I don't eat beef, and I always drink black coffee. I play badminton on Tuesday and Thursday evenings.",
	"About my studies: my Thermodynamics lab report is due on 6 November, my lab partner is Farhan, and I like explanations that use Python code. Oh, and my dog is called Biscuit.",
];
export const QUESTIONS_2 = [
	{ id: 'p01', kind: 'direct', q: 'Which university am I at?', expect: [/malaya|\bUM\b/i] },
	{ id: 'p02', kind: 'direct', q: "What's my course, and how far along am I?", expect: [/mechanical/i, /final|fourth|4th|last/i] },
	{ id: 'p03', kind: 'direct', q: 'Where do I live?', expect: [/petaling|\bPJ\b/i] },
	{ id: 'p04', kind: 'direct', q: 'What time of day do I work best?', expect: [/morning/i] },
	{ id: 'p05', kind: 'direct', q: "Is there anything my stomach can't handle?", expect: [/lactose|dairy/i] },
	{ id: 'p06', kind: 'direct', q: 'Is there a meat I avoid?', expect: [/beef/i] },
	{ id: 'p07', kind: 'direct', q: 'What do I usually drink?', expect: [/coffee/i] },
	{ id: 'p08', kind: 'direct', q: 'When do I play badminton?', expect: [/tue/i, /thu/i] },
	{ id: 'p09', kind: 'direct', q: 'When is my Thermodynamics lab report due?', expect: [/6\s*(th)?\s*nov|nov(ember)?\s*6/i] },
	{ id: 'p10', kind: 'direct', q: "Who's my lab partner?", expect: [/farhan/i] },
	{ id: 'p11', kind: 'direct', q: 'What sort of explanations do I like?', expect: [/python/i] },
	{ id: 'p12', kind: 'direct', q: "What's my dog's name?", expect: [/biscuit/i] },
	{ id: 'p13', kind: 'applied', q: 'Suggest a quick dessert I could make tonight. Just one idea, briefly.', expect: [/./], avoid: [/(?<!coconut |almond |oat |soy |dairy-free |lactose-free |non-dairy )\b(milk|cream|butter|cheese|yogurt|yoghurt|custard)\b/i], judge: 'no dairy unless made dairy-free' },
	{ id: 'p14', kind: 'applied', q: "I want to plan this coming Thursday evening. Anything I usually do that I should keep in mind?", expect: [/badminton/i] },
	{ id: 'p15', kind: 'applied', q: 'Explain binary search to me in a few lines.', expect: [/python|\bdef\s+\w+\s*\(/i] },
	{ id: 'p16', kind: 'applied', q: "I'm at a café. What should I get to drink?", expect: [/black coffee/i] },
	{ id: 'p17', kind: 'unknown', q: "What's my brother's name?", expect: [SAYS_UNKNOWN], judge: 'says it does not know (never told)' },
	{ id: 'p18', kind: 'unknown', q: "What's my matric number?", expect: [SAYS_UNKNOWN], judge: 'says it does not know (never told)' },
	{ id: 'p19', kind: 'unknown', q: 'Which laptop do I use?', expect: [SAYS_UNKNOWN], judge: 'says it does not know (never told)' },
	{ id: 'p20', kind: 'unknown', q: 'What shoe size do I wear?', expect: [SAYS_UNKNOWN], judge: 'says it does not know (never told)' },
];
export function autoGrade(question, answer) {
	const a = answer || '';
	const ok = question.expect.every((re) => re.test(a)) && !(question.avoid || []).some((re) => re.test(a));
	return ok;
}
