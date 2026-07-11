import { NextRequest, NextResponse } from "next/server";
import { answer } from "@/lib/rag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const { question, city } = await req.json();
    if (!question || typeof question !== "string" || question.trim().length < 3) {
      return NextResponse.json({ error: "Please ask a question." }, { status: 400 });
    }
    const result = await answer(question.trim(), {
      city: typeof city === "string" && city ? city : undefined,
    });
    return NextResponse.json(result);
  } catch (err: any) {
    console.error("ask error:", err);
    return NextResponse.json(
      { error: "Something went wrong answering that. Please try again." },
      { status: 500 }
    );
  }
}
