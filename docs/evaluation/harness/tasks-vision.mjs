// Pictures with known answers (rendered from local HTML), sent as image attachments. The main chat model (Nemotron 3.5
// Lightning) reads text only, so MyHarness's vision assistant (Nemotron 3.5 Super VL) looks at them.
export const VISION_TASKS = [
	{ key: 'chart', image: 'v1-chart.png', prompt: "Here's my expense chart. Which category did I spend the most on, how much was it, and what's the total across all five categories?", expect: [/rent/i, /\b900\b/, /1,?595/] },
	{ key: 'timetable', image: 'v2-timetable.png', prompt: 'From my timetable, what class do I have on Thursday, at what time, and in which room?', expect: [/discrete math/i, /11[:.]00|11\s*am/i, /c\s?105/i] },
	{ key: 'receipt', image: 'v3-receipt.png', prompt: 'How much did I pay in total on this receipt, and how much was the teh tarik?', expect: [/13\.04/, /2\.80/] },
	{ key: 'portal', image: 'v4-portal.png', prompt: 'Based on this screenshot of my course portal, when is the Software Architecture group report due?', expect: [/4\s*nov|nov(ember)?\s*4/i, /17[:.]00|5(:00)?\s*pm/i] },
	{ key: 'error', image: 'v5-error.png', prompt: 'My script crashed with this error. Which file is it failing to open, and what is the likely cause?', expect: [/october-expenses\.csv/i, /not exist|doesn'?t exist|does not exist|missing|no such file|not found|wrong path|moved|renamed/i] },
];
