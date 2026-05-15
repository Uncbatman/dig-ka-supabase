import { createClient } from "@supabase/supabase-js";

const supabaseUrl =
  process.env.SUPABASE_URL || "https://gysnzrxpepoctftglprm.supabase.co";
const supabaseAnonKey =
  process.env.SUPABASE_KEY || "sb_publishable_N2Xex93bCO1TyWiRYX5h2w_SIoC5rL5";

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
