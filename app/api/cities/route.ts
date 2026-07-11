import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rows = await query(
      `SELECT ct.slug, ct.name, ct.source_url, ct.fetched_on,
              count(c.id)::int AS chunks
       FROM cities ct
       LEFT JOIN chunks c ON c.city_slug = ct.slug
       GROUP BY ct.slug, ct.name, ct.source_url, ct.fetched_on
       ORDER BY ct.name`
    );
    return NextResponse.json({ cities: rows });
  } catch (err) {
    console.error("cities error:", err);
    return NextResponse.json({ cities: [] }, { status: 500 });
  }
}
