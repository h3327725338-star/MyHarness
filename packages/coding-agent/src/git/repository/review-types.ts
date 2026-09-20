// ============================================================================
// 工作区变化共享类型
//
// 底层模块（workspace-changes、git-integration）使用的工作区变化类型。
// ============================================================================

export type AutoReviewMutationToolName = "edit" | "write" | "bash";

export type ReviewChangeStatus = "added" | "modified" | "deleted" | "renamed";

/**
 * 一次真实工作区变化。path 是相对任务工作目录的路径（正斜杠），
 * 只描述“文件系统当前状态相对本轮开始前基线”的变化，
 * 与工具调用记录（AutoReviewMutation）相互独立。
 */
export interface ReviewChange {
	path: string;
	status: ReviewChangeStatus;
	oldPath?: string;
}

export interface AutoReviewMutation {
	toolName: AutoReviewMutationToolName;
	operation?: AutoReviewMutationToolName;
	path: string;
	/** 该条记录对应的真实工作区变化状态；edit/write 由前后快照推断，bash 由变化检测产生。 */
	status?: ReviewChangeStatus;
	/** status 为 renamed 时的原路径（相对任务工作目录，正斜杠）。 */
	oldPath?: string;
	id?: string;
	startedAt?: string;
	finishedAt?: string;
	beforeHash?: string;
	afterHash?: string;
	lineCountBefore?: number;
	lineCountAfter?: number;
	success?: boolean;
}
