import { win32 as windowsPath } from "node:path";

export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
	".c": "c",
	".cc": "cpp",
	".cpp": "cpp",
	".cxx": "cpp",
	".cs": "csharp",
	".go": "go",
	".h": "c",
	".hpp": "cpp",
	".java": "java",
	".js": "javascript",
	".jsx": "javascript",
	".json": "json",
	".kt": "kotlin",
	".kts": "kotlin",
	".mjs": "javascript",
	".php": "php",
	".py": "python",
	".rb": "ruby",
	".rs": "rust",
	".scss": "scss",
	".sh": "shell",
	".sql": "sql",
	".swift": "swift",
	".svelte": "svelte",
	".ts": "typescript",
	".tsx": "typescript",
	".vue": "vue",
	".xml": "xml",
	".yaml": "yaml",
	".yml": "yaml",
};

export function getCodeLanguage(filePath: string): string | undefined {
	return LANGUAGE_BY_EXTENSION[windowsPath.extname(filePath).toLowerCase()];
}
