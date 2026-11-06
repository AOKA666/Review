import { NextResponse } from "next/server";
import { readReviews, saveReviews } from "../../../lib/reviews-service";
import { getSupabaseAdmin } from "../../../lib/supabase";
import {
  ReviewsQueryClient,
  SupabaseReviewsRepository
} from "../../../lib/supabase-reviews-repository";

const OWNER_KEY = "default";

const repository = () =>
  new SupabaseReviewsRepository(getSupabaseAdmin() as unknown as ReviewsQueryClient);

export async function GET() {
  try {
    const result = await readReviews(repository(), OWNER_KEY);
    if (result.status !== 200) {
      console.error(`Supabase GET ${result.stage}`);
      return NextResponse.json(result.body, { status: 500 });
    }
    return NextResponse.json(result.body);
  } catch {
    console.error("Supabase GET supabase_init");
    return NextResponse.json(
      { reviews: [], updated_at: null },
      { status: 500, statusText: "Supabase env not configured" }
    );
  }
}

export async function POST(request: Request) {
  let repo: SupabaseReviewsRepository;
  try {
    repo = repository();
  } catch {
    console.error("Supabase POST supabase_init");
    return NextResponse.json(
      { ok: false, error: "supabase_init" },
      { status: 500, statusText: "Supabase env not configured" }
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_json" },
      { status: 400, statusText: "Invalid JSON payload" }
    );
  }

  try {
    const result = await saveReviews(repo, OWNER_KEY, payload);
    if (result.status >= 500) {
      console.error(`Supabase POST ${result.body.ok ? "save_failed" : result.body.error}`);
    }
    return NextResponse.json(result.body, { status: result.status });
  } catch {
    console.error("Supabase POST save_failed");
    return NextResponse.json({ ok: false, error: "save_failed" }, { status: 500 });
  }
}
