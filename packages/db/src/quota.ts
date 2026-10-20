import pg from "pg";

export type ReservationResult = "ok" | "pool";

export type ReserveEbayCallInput = {
  resource: "buy.browse";
  callClass: "standard" | "alert-path";
  purpose: string;
  minLeft: number;
  now: Date;
};

// The caller's clock is more than 300 s from the database clock (SQLSTATE EB001).
export class QuotaClockSkewError extends Error {}

export async function reserveEbayCall(pool: pg.Pool, input: ReserveEbayCallInput): Promise<ReservationResult> {
  let result: string | undefined;
  try {
    const rows = await pool.query<{ result: string }>("SELECT app.reserve_ebay_call($1, $2, $3, $4, $5) AS result", [
      input.resource,
      input.callClass,
      input.purpose,
      input.minLeft,
      input.now,
    ]);
    result = rows.rows[0]?.result;
  } catch (error) {
    if (error instanceof pg.DatabaseError && error.code === "EB001") {
      throw new QuotaClockSkewError(error.message, { cause: error });
    }
    throw error;
  }
  if (result === "ok" || result === "pool") return result;
  throw new Error("reserve_ebay_call returned an unknown result");
}
