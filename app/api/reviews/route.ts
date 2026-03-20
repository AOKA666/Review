import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "../../../lib/supabase";
import { ReviewRecord } from "../../../lib/review";

const TABLE_NAME = "repano_reviews";
const OWNER_KEY = "default";

type SelectResponse =
  | {
      reviews: ReviewRecord[];
      updated_at: string | null;
    }
  | {
      reviews: [];
      updated_at: null;
    };

export async function GET(): Promise<NextResponse<SelectResponse>> {
  let supabase;
  try {
    supabase = getSupabaseAdmin();
  } catch (error) {
    console.error("Supabase init error", error);
    return NextResponse.json(
      { reviews: [], updated_at: null },
      { status: 500, statusText: "Supabase env not configured" }
    );
  }
  const { data, error } = await supabase
    .from(TABLE_NAME)
    .select("payload, updated_at")
    .eq("owner", OWNER_KEY)
    .maybeSingle();

  if (error) {
    console.error("Supabase GET error", error);
    return NextResponse.json(
      { reviews: [], updated_at: null },
      { status: 500 }
    );
  }

  const reviews = (data?.payload as ReviewRecord[]) ?? [];
  const updated_at = data?.updated_at ?? null;
  return NextResponse.json({ reviews, updated_at });
}

export async function POST(
  request: Request
): Promise<NextResponse<{ ok: boolean }>> {
  let supabase;
  try {
    supabase = getSupabaseAdmin();
  } catch (error) {
    console.error("Supabase init error", error);
    return NextResponse.json(
      { ok: false },
      { status: 500, statusText: "Supabase env not configured" }
    );
  }
  let payload: { reviews: ReviewRecord[] };
  try {
    payload = await request.json();
  } catch (error) {
    return NextResponse.json(
      { ok: false },
      { status: 400, statusText: "Invalid JSON payload" }
    );
  }

  if (!Array.isArray(payload.reviews)) {
    return NextResponse.json(
      { ok: false },
      { status: 400, statusText: "Expected reviews array" }
    );
  }

  const now = new Date().toISOString();
  const { error } = await supabase.from(TABLE_NAME).upsert(
    {
      owner: OWNER_KEY,
      payload: payload.reviews,
      updated_at: now
    },
    {
      onConflict: "owner"
    }
  );

  if (error) {
    console.error("Supabase POST error", error);
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
