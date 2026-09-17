"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

/**
 * Who is signed in, as the control plane sees it.
 *
 * The answer is never cached across a login: FA-02.2 rebuilds the session's
 * entitlements from the directory at every login, and an interface that
 * remembered the previous answer would be showing an area the user may no
 * longer be entitled to.
 */
export function useSession() {
  return useQuery({
    queryKey: ["session"],
    queryFn: () => api.session(),
    staleTime: 30_000,
  });
}
