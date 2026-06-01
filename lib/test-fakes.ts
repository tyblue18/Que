/**
 * lib/test-fakes.ts
 *
 * An in-memory stand-in for the Prisma client, used by the engine unit tests
 * (battleEngine / coinEngine / walletOps) to exercise the money-moving code
 * paths without a database. It implements only the surface those engines touch.
 *
 * It faithfully models the two properties the tests care about:
 *   • `$transaction(fn)` rolls back ALL mutations if `fn` throws (snapshot +
 *     restore), so overdraft/double-pay guards can be asserted to leave state
 *     untouched.
 *   • `updateMany({ where: { status } })` only applies (and reports count: 1)
 *     when the row's current status matches — the compare-and-set the engines
 *     rely on to be idempotent.
 *
 * Not a test file itself (no `.test.ts`), so the runner ignores it; it's never
 * imported by app code, so it never ships.
 */

export interface FakeWallet { id: string; userId: string; balance: number }
export interface FakeTxn    { id: string; walletId: string; amount: number; reason: string; refId: string | null }
export interface FakeChallenge {
  id: string; challengerId: string; challengeeId: string;
  wager: number; status: string; categories: unknown; type: string | null;
  startDate: string | null; endDate: string | null;
  winnerId?: string | null; resolution?: unknown; resolvedAt?: Date | null;
}
export interface FakeParticipant { userId: string; team: number }
export interface FakeTeamBattle {
  id: string; status: string; mode: string; wager: number; categories: unknown;
  startDate: string | null; endDate: string | null; participants: FakeParticipant[];
  winningTeam?: number | null; resolution?: unknown; resolvedAt?: Date | null;
}
export interface FakeDay { userId: string; date: string; data: Record<string, unknown> }

export interface FakeAppUser { id: string; username: string | null; leaderboardOptIn: boolean }

interface State {
  wallets:      FakeWallet[];
  txns:         FakeTxn[];
  challenges:   FakeChallenge[];
  teamBattles:  FakeTeamBattle[];
  days:         FakeDay[];
  users:        FakeAppUser[];
  subs:         string[]; // push-subscribed userIds
  walletSeq:    number;
  txnSeq:       number;
}

type DateFilter = { gte?: string; lte?: string };
type UserIdFilter = string | { in: string[] };

export interface FakePrisma {
  state: State;
  // ── seeding helpers (test setup) ──
  seedWallet(userId: string, balance: number): FakeWallet;
  seedChallenge(c: FakeChallenge): FakeChallenge;
  seedTeamBattle(t: FakeTeamBattle): FakeTeamBattle;
  seedDay(userId: string, date: string, data: Record<string, unknown>): void;
  seedUser(u: FakeAppUser): FakeAppUser;
  seedSub(userId: string): void;
  walletOf(userId: string): FakeWallet | undefined;
  txnsFor(refId: string): FakeTxn[];
  // ── prisma-like surface (subset the engines use) ──
  coinWallet: {
    upsert(args: { where: { userId: string }; create: { userId: string; balance: number }; update: object; include?: { transactions?: { where?: { reason?: string } } } }): Promise<FakeWallet & { transactions?: FakeTxn[] }>;
    update(args: { where: { id: string }; data: { balance: { increment?: number; decrement?: number } } }): Promise<FakeWallet>;
  };
  coinTransaction: { create(args: { data: { walletId: string; amount: number; reason: string; refId?: string | null } }): Promise<FakeTxn> };
  challenge:  {
    findUnique(args: { where: { id: string } }): Promise<FakeChallenge | null>;
    updateMany(args: { where: { id: string; status?: string }; data: Partial<FakeChallenge> }): Promise<{ count: number }>;
    findMany(args: { where: { status?: string; endDate?: string }; select?: unknown }): Promise<FakeChallenge[]>;
  };
  teamBattle: {
    findUnique(args: { where: { id: string }; include?: unknown }): Promise<FakeTeamBattle | null>;
    updateMany(args: { where: { id: string; status?: string }; data: Partial<FakeTeamBattle> }): Promise<{ count: number }>;
    findMany(args: { where: { status?: string; endDate?: string }; include?: unknown }): Promise<FakeTeamBattle[]>;
  };
  pushSubscription: { findMany(args: { distinct?: string[]; select?: unknown }): Promise<Array<{ userId: string }>> };
  dayRecord:  { findMany(args: { where: { userId: UserIdFilter; date?: DateFilter }; select?: unknown; orderBy?: unknown }): Promise<Array<{ userId: string; date: string; data: Record<string, unknown> }>> };
  appUser:    { findMany(args: { where?: { leaderboardOptIn?: boolean; username?: { not: null } }; select?: unknown }): Promise<Array<{ id: string; username: string | null }>> };
  $transaction<T>(fn: (tx: FakePrisma) => Promise<T>): Promise<T>;
}

export function makeFakePrisma(): FakePrisma {
  const fake = {
    state: {
      wallets: [], txns: [], challenges: [], teamBattles: [], days: [], users: [], subs: [],
      walletSeq: 0, txnSeq: 0,
    } as State,
  } as FakePrisma;

  // Mutations always read fake.state so $transaction can swap it out on rollback.
  const ensureWallet = (userId: string, balance = 0): FakeWallet => {
    let w = fake.state.wallets.find(x => x.userId === userId);
    if (!w) { w = { id: `w${++fake.state.walletSeq}`, userId, balance }; fake.state.wallets.push(w); }
    return w;
  };

  fake.seedWallet      = (userId, balance) => ensureWallet(userId, balance);
  fake.seedChallenge   = c => { fake.state.challenges.push(c); return c; };
  fake.seedTeamBattle  = t => { fake.state.teamBattles.push(t); return t; };
  fake.seedDay         = (userId, date, data) => { fake.state.days.push({ userId, date, data }); };
  fake.seedUser        = u => { fake.state.users.push(u); return u; };
  fake.seedSub         = userId => { if (!fake.state.subs.includes(userId)) fake.state.subs.push(userId); };
  fake.walletOf        = userId => fake.state.wallets.find(w => w.userId === userId);
  fake.txnsFor         = refId => fake.state.txns.filter(t => t.refId === refId);

  fake.coinWallet = {
    async upsert(args) {
      const w = ensureWallet(args.where.userId, args.create.balance);
      if (args.include?.transactions) {
        const reason = args.include.transactions.where?.reason;
        const transactions = fake.state.txns.filter(t => t.walletId === w.id && (reason ? t.reason === reason : true));
        return { ...w, transactions };
      }
      return w;
    },
    async update(args) {
      const w = fake.state.wallets.find(x => x.id === args.where.id);
      if (!w) throw new Error(`wallet ${args.where.id} not found`);
      if (typeof args.data.balance.increment === 'number') w.balance += args.data.balance.increment;
      if (typeof args.data.balance.decrement === 'number') w.balance -= args.data.balance.decrement;
      return w;
    },
  };

  fake.coinTransaction = {
    async create(args) {
      const t: FakeTxn = { id: `t${++fake.state.txnSeq}`, refId: null, ...args.data };
      fake.state.txns.push(t);
      return t;
    },
  };

  fake.challenge = {
    async findUnique(args) { return fake.state.challenges.find(c => c.id === args.where.id) ?? null; },
    async updateMany(args) {
      const c = fake.state.challenges.find(x => x.id === args.where.id);
      if (!c) return { count: 0 };
      if (args.where.status !== undefined && c.status !== args.where.status) return { count: 0 };
      Object.assign(c, args.data);
      return { count: 1 };
    },
    async findMany(args) {
      const { status, endDate } = args.where;
      return fake.state.challenges
        .filter(c => status === undefined || c.status === status)
        .filter(c => endDate === undefined || c.endDate === endDate);
    },
  };

  fake.teamBattle = {
    async findUnique(args) { return fake.state.teamBattles.find(t => t.id === args.where.id) ?? null; },
    async updateMany(args) {
      const t = fake.state.teamBattles.find(x => x.id === args.where.id);
      if (!t) return { count: 0 };
      if (args.where.status !== undefined && t.status !== args.where.status) return { count: 0 };
      Object.assign(t, args.data);
      return { count: 1 };
    },
    async findMany(args) {
      const { status, endDate } = args.where;
      return fake.state.teamBattles
        .filter(t => status === undefined || t.status === status)
        .filter(t => endDate === undefined || t.endDate === endDate);
    },
  };

  fake.pushSubscription = {
    async findMany() { return [...new Set(fake.state.subs)].map(userId => ({ userId })); },
  };

  fake.dayRecord = {
    async findMany(args) {
      const { userId, date } = args.where;
      const matchesUser = (id: string) =>
        typeof userId === 'string' ? id === userId : userId.in.includes(id);
      return fake.state.days
        .filter(d => matchesUser(d.userId))
        .filter(d => !date?.gte || d.date >= date.gte)
        .filter(d => !date?.lte || d.date <= date.lte)
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
        .map(d => ({ userId: d.userId, date: d.date, data: d.data }));
    },
  };

  fake.appUser = {
    async findMany(args) {
      const w = args.where ?? {};
      return fake.state.users
        .filter(u => w.leaderboardOptIn === undefined || u.leaderboardOptIn === w.leaderboardOptIn)
        .filter(u => !w.username || u.username !== null) // { username: { not: null } }
        .map(u => ({ id: u.id, username: u.username }));
    },
  };

  fake.$transaction = async function <T>(fn: (tx: FakePrisma) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(fake.state);
    try {
      return await fn(fake);
    } catch (e) {
      fake.state = snapshot; // roll back every mutation the callback made
      throw e;
    }
  };

  return fake;
}
