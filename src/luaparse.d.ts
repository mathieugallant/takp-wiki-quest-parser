/**
 * Minimal TypeScript declarations for the `luaparse` package (v0.3.x).
 * Only the node types and options used by ast-extractor.ts are covered.
 */
declare module 'luaparse' {
  // ─── Parse options ────────────────────────────────────────────────────────

  interface ParseOptions {
    /** Lua version to target. Default '5.1'. */
    luaVersion?: '5.1' | '5.2' | '5.3' | 'LuaJIT';
    /** Whether to store comments in the chunk. Default true. */
    comments?: boolean;
    /** How to handle non-ASCII bytes in string literals. Default 'none'. */
    encodingMode?: 'none' | 'pseudo-latin1' | 'x-user-defined';
    /** Store location info on nodes. Default false. */
    locations?: boolean;
    /** Store range info on nodes. Default false. */
    ranges?: boolean;
  }

  // ─── Base ─────────────────────────────────────────────────────────────────

  interface BaseNode {
    type: string;
  }

  // ─── Statements ───────────────────────────────────────────────────────────

  interface Chunk extends BaseNode {
    type: 'Chunk';
    body: Statement[];
    comments?: Comment[];
  }

  interface FunctionDeclaration extends BaseNode {
    type: 'FunctionDeclaration';
    identifier: Identifier | MemberExpression | null;
    isLocal: boolean;
    parameters: (Identifier | VarargLiteral)[];
    body: Statement[];
  }

  interface LocalStatement extends BaseNode {
    type: 'LocalStatement';
    variables: Identifier[];
    init: Expression[];
  }

  interface AssignmentStatement extends BaseNode {
    type: 'AssignmentStatement';
    variables: Expression[];
    init: Expression[];
  }

  interface CallStatement extends BaseNode {
    type: 'CallStatement';
    expression: CallExpression | StringCallExpression | TableCallExpression;
  }

  interface IfStatement extends BaseNode {
    type: 'IfStatement';
    clauses: (IfClause | ElseifClause | ElseClause)[];
  }

  interface IfClause extends BaseNode {
    type: 'IfClause';
    condition: Expression;
    body: Statement[];
  }

  interface ElseifClause extends BaseNode {
    type: 'ElseifClause';
    condition: Expression;
    body: Statement[];
  }

  interface ElseClause extends BaseNode {
    type: 'ElseClause';
    body: Statement[];
  }

  interface ReturnStatement extends BaseNode {
    type: 'ReturnStatement';
    arguments: Expression[];
  }

  interface WhileStatement extends BaseNode {
    type: 'WhileStatement';
    condition: Expression;
    body: Statement[];
  }

  interface RepeatStatement extends BaseNode {
    type: 'RepeatStatement';
    condition: Expression;
    body: Statement[];
  }

  interface ForNumericStatement extends BaseNode {
    type: 'ForNumericStatement';
    variable: Identifier;
    start: Expression;
    end: Expression;
    step: Expression | null;
    body: Statement[];
  }

  interface ForGenericStatement extends BaseNode {
    type: 'ForGenericStatement';
    variables: Identifier[];
    iterators: Expression[];
    body: Statement[];
  }

  interface DoStatement extends BaseNode {
    type: 'DoStatement';
    body: Statement[];
  }

  interface BreakStatement extends BaseNode { type: 'BreakStatement'; }
  interface GotoStatement extends BaseNode { type: 'GotoStatement'; label: Identifier; }
  interface LabelStatement extends BaseNode { type: 'LabelStatement'; label: Identifier; }

  type Statement =
    | FunctionDeclaration
    | LocalStatement
    | AssignmentStatement
    | CallStatement
    | IfStatement
    | ReturnStatement
    | WhileStatement
    | RepeatStatement
    | ForNumericStatement
    | ForGenericStatement
    | DoStatement
    | BreakStatement
    | GotoStatement
    | LabelStatement;

  // ─── Expressions ──────────────────────────────────────────────────────────

  interface Identifier extends BaseNode {
    type: 'Identifier';
    name: string;
  }

  interface StringLiteral extends BaseNode {
    type: 'StringLiteral';
    value: string | null;
    raw: string;
  }

  interface NumericLiteral extends BaseNode {
    type: 'NumericLiteral';
    value: number;
    raw: string;
  }

  interface BooleanLiteral extends BaseNode {
    type: 'BooleanLiteral';
    value: boolean;
  }

  interface NilLiteral extends BaseNode { type: 'NilLiteral'; value: null; }
  interface VarargLiteral extends BaseNode { type: 'VarargLiteral'; value: string; }

  interface MemberExpression extends BaseNode {
    type: 'MemberExpression';
    indexer: '.' | ':';
    base: Expression;
    identifier: Identifier;
  }

  interface IndexExpression extends BaseNode {
    type: 'IndexExpression';
    base: Expression;
    index: Expression;
  }

  interface CallExpression extends BaseNode {
    type: 'CallExpression';
    base: Expression;
    arguments: Expression[];
  }

  interface StringCallExpression extends BaseNode {
    type: 'StringCallExpression';
    base: Expression;
    argument: StringLiteral;
  }

  interface TableCallExpression extends BaseNode {
    type: 'TableCallExpression';
    base: Expression;
    arguments: TableConstructorExpression;
    argument: TableConstructorExpression;
  }

  interface TableConstructorExpression extends BaseNode {
    type: 'TableConstructorExpression';
    fields: (TableKey | TableKeyString | TableValue)[];
  }

  interface TableKey extends BaseNode {
    type: 'TableKey';
    key: Expression;
    value: Expression;
  }

  interface TableKeyString extends BaseNode {
    type: 'TableKeyString';
    key: Identifier;
    value: Expression;
  }

  interface TableValue extends BaseNode {
    type: 'TableValue';
    value: Expression;
  }

  interface BinaryExpression extends BaseNode {
    type: 'BinaryExpression';
    operator: string;
    left: Expression;
    right: Expression;
  }

  interface LogicalExpression extends BaseNode {
    type: 'LogicalExpression';
    operator: 'and' | 'or';
    left: Expression;
    right: Expression;
  }

  interface UnaryExpression extends BaseNode {
    type: 'UnaryExpression';
    operator: string;
    argument: Expression;
  }

  interface FunctionExpression extends BaseNode {
    type: 'FunctionDeclaration';
    identifier: null;
    isLocal: boolean;
    parameters: (Identifier | VarargLiteral)[];
    body: Statement[];
  }

  interface Comment extends BaseNode {
    type: 'Comment';
    value: string;
    raw: string;
  }

  type Expression =
    | Identifier
    | StringLiteral
    | NumericLiteral
    | BooleanLiteral
    | NilLiteral
    | VarargLiteral
    | MemberExpression
    | IndexExpression
    | CallExpression
    | StringCallExpression
    | TableCallExpression
    | TableConstructorExpression
    | BinaryExpression
    | LogicalExpression
    | UnaryExpression
    | FunctionDeclaration;

  // ─── Public API ───────────────────────────────────────────────────────────

  function parse(code: string, options?: ParseOptions): Chunk;
}
