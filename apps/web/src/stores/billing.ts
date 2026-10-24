import axios from "@/utils/axios";
import { loadBillingAccount, type BillingAccount, type BillingAccountLoadState } from "@/views/billing/billingData";

export default defineStore("billingAccount", () => {
  const account = ref<BillingAccount | null>(null);
  const loading = ref(false);
  const error = ref("");

  const loadState: BillingAccountLoadState = {
    get account() { return account.value; },
    set account(value) { account.value = value; },
    get loading() { return loading.value; },
    set loading(value) { loading.value = value; },
    get error() { return error.value; },
    set error(value) { error.value = value; },
  };

  async function refreshAccount(): Promise<void> {
    await loadBillingAccount(loadState, async () => {
      const response: any = await axios.get("/billing/account");
      const data = response?.data;
      if (!data || data.balanceMicro === undefined || data.frozenMicro === undefined) {
        throw new Error("账户数据异常，请刷新重试");
      }
      return {
        balanceMicro: String(data.balanceMicro),
        frozenMicro: String(data.frozenMicro),
      };
    });
  }

  return { account, loading, error, refreshAccount };
});
