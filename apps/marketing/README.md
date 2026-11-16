# @brainiac/marketing

The public site (#52): one page that explains Brainiac and gets people to start a record. Astro, static output,
served as a Worker's assets (`alchemy.run.ts`). Motion is CSS scroll-driven animation plus `motion` for the hero
and the steps; all of it is off with reduced motion.

```sh
vp run --filter @brainiac/marketing dev     # http://localhost:4321
vp run --filter @brainiac/marketing build   # dist/
```
