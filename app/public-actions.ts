"use server";

import { updateTag } from "next/cache";
import { publicResultsCacheTag } from "@/lib/public-results";

export async function refreshPublicResultsAction(eventSlug: string) {
  const slug = eventSlug.trim();
  if (slug.length > 160 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(slug)) {
    throw new Error("El evento indicado no es válido.");
  }

  updateTag(publicResultsCacheTag(slug));
}
