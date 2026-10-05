// Matching path commands let the terminal outline and prompt become a chat bubble and two lines.
// Numeric interpolation works in browsers without CSS `d` interpolation or SVG SMIL.
const CODING = [5, 4, 19, 4, 21, 4, 21, 6, 21, 18, 21, 20, 19, 20, 5, 20, 3, 20, 3, 18, 3, 6, 3, 4, 5, 4];
const GENERAL = [5, 4, 19, 4, 21, 4, 21, 6, 21, 15, 21, 17, 19, 17, 9, 17, 3, 21, 3, 19, 3, 6, 3, 4, 5, 4];
const lerp = (a, b, t) => a + (b - a) * t;

export function modeIconPaths(progress) {
	const t = Math.max(0, Math.min(1, progress));
	const n = CODING.map((value, i) => Number(lerp(value, GENERAL[i], t).toFixed(3)));
	return [
		`M ${n[0]} ${n[1]} L ${n[2]} ${n[3]} Q ${n[4]} ${n[5]} ${n[6]} ${n[7]} L ${n[8]} ${n[9]} Q ${n[10]} ${n[11]} ${n[12]} ${n[13]} L ${n[14]} ${n[15]} Q ${n[16]} ${n[17]} ${n[18]} ${n[19]} L ${n[20]} ${n[21]} Q ${n[22]} ${n[23]} ${n[24]} ${n[25]} Z`,
		`M 7 9 L ${lerp(10, 12, t)} ${lerp(12, 9, t)} L ${lerp(7, 17, t)} ${lerp(15, 9, t)}`,
		`M ${lerp(13, 7, t)} ${lerp(15, 13, t)} L ${lerp(17, 12, t)} ${lerp(15, 13, t)}`,
	];
}
