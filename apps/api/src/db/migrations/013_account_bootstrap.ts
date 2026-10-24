import type { Knex } from "knex";

export default {
  name: "013_account_bootstrap",

  async up(knex: Knex): Promise<void> {
    const users = (await knex("o_user")
      .select("o_user.id")
      .whereNotExists(function () {
        this.select(knex.raw("1"))
          .from("o_account")
          .whereRaw("?? = ??", ["o_account.userId", "o_user.id"]);
      })) as Array<{ id: number | string }>;
    if (users.length === 0) return;

    const updatedAt = Date.now();
    await knex("o_account").insert(users.map(({ id }) => ({
      userId: id,
      balanceMicro: 0,
      frozenMicro: 0,
      version: 0,
      updatedAt,
    })));
  },

  async down(_knex: Knex): Promise<void> {
    // Account rows may have been used or modified since bootstrap; never delete them.
  },
};
