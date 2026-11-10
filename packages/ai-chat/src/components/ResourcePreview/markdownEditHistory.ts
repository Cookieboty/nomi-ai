export interface MarkdownCaret {
  block: number;
  offset: number;
}
export interface MarkdownSnapshot {
  text: string;
  caret?: MarkdownCaret;
  sourceSelection?: { anchor: number; head: number };
}
/** Browser block joins are source transactions, so their undo restores source and DOM together. */
export class MarkdownEditHistory {
  private undoStack: MarkdownSnapshot[] = [];
  private redoStack: MarkdownSnapshot[] = [];
  private lastGroup = '';
  private at = 0;
  present: MarkdownSnapshot;
  constructor(text: string) {
    this.present = { text };
  }
  closeGroup() {
    this.lastGroup = '';
  }
  record(
    text: string,
    caret?: MarkdownCaret,
    group = '',
    sourceSelection?: MarkdownSnapshot['sourceSelection'],
  ) {
    if (text === this.present.text) return;
    const now = Date.now();
    if (!group || group !== this.lastGroup || now - this.at > 600) {
      this.undoStack.push(this.present);
      if (this.undoStack.length > 100) this.undoStack.shift();
    }
    this.redoStack = [];
    this.present = { text, caret, sourceSelection };
    this.lastGroup = group;
    this.at = now;
  }
  undo() {
    const previous = this.undoStack.pop();
    if (!previous) return undefined;
    this.redoStack.push(this.present);
    this.present = previous;
    this.lastGroup = '';
    return previous;
  }
  redo() {
    const next = this.redoStack.pop();
    if (!next) return undefined;
    this.undoStack.push(this.present);
    this.present = next;
    this.lastGroup = '';
    return next;
  }
}
