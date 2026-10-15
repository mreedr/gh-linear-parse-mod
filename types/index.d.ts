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
    }
  }
}
