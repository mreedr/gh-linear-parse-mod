export type Item = {
  key: string
  url: string
}

export type PrState = 'open' | 'draft' | 'merged' | 'closed'
export type CI = 'pass' | 'fail' | 'running' | 'none'
export type Review = 'approved' | 'changes' | 'commented' | 'pending' | 'unassigned'

export type PrStatus = {
  state: PrState | 'unknown'
  ci: CI
  review?: Review
  title?: string
  author?: string
  additions?: number
  deletions?: number
  hasConflict?: boolean
  checkedAt: number
  ciSince?: number
}

export type IssueType = 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled' | 'duplicate'

// A Linear issue's workflow status; neither field when the read failed.
export type IssueStatus = {
  name?: string
  type?: IssueType
  checkedAt: number
}

// What the session's agent says it is doing, set through the set_status tool.
export type StatusNote = {
  text: string
  setAt: number
}

// A group in the GitHub section, set through the group_prs tool: a label, a line of text, PRs (keys), or any mix;
// or a step, a to-do row of its own that is ticked when done.
export type PrGroup = {
  label?: string
  text?: string
  prs: string[]
  step?: string
  isDone?: boolean
}

// One change edit_groups makes to the groups.
export type GroupEdit = {
  op?: string
  pr?: string
  group?: number
  at?: number
  label?: string
  text?: string
  prs?: string[]
  step?: string
  done?: boolean
}

// The PRs in the band when the groups were last set, and which were still open, so
// links_band can say what changed since.
export type GroupingBase = {
  seen: string[]
  live: string[]
}

export type BandColor = {
  color: string
  isFill: boolean
}

declare module 'claude-code' {
  interface McpToolInputs {
    /** This session's links band state; the mod registers and answers it itself. */
    'mcp__gh-linear-parse-mod__links_band': {}
    /** Sets or clears the status line at the top of the band. */
    'mcp__gh-linear-parse-mod__set_status': { text?: string }
    /** Sets the GitHub section's groups, top to bottom; an empty list clears them. */
    'mcp__gh-linear-parse-mod__group_prs': { groups?: { label?: string; text?: string; prs?: string[]; step?: string; done?: boolean }[] }
    /** Changes the groups in place, one edit at a time. */
    'mcp__gh-linear-parse-mod__edit_groups': { edits?: GroupEdit[] }
  }

  interface PluginState {
    'gh-linear-parse-mod': {
      items: Item[]
      dismissed: string[]
      isHidden: boolean
      isExpanded: boolean
      bandColor: BandColor | null
      hasBackfilled: boolean
      prStatuses: Record<string, PrStatus>
      issueStatuses: Record<string, IssueStatus>
      isWatching: boolean
      refreshing: number
      agentStatus: StatusNote | null
      prGroups: PrGroup[] | null
      groupingBase: GroupingBase | null
      showsLanded: boolean
      hidesAwaitingReview: boolean
      isSigningIn: boolean
      isSigningInVercel: boolean
    }
  }
}
