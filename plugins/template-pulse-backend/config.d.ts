export interface Config {
  templatePulse?: {
    /** Service scan limit, or database detail page size. Default 200; range 1-1000. */
    maxTasks?: number;
    /** Override automatic history source detection. Database requires the Scaffolder history module; service uses the bounded public API. */
    historySource?: 'database' | 'service';
    /** Maximum database rollup groups per dimension. Summary metrics remain complete; filter choices use bounded server search. Default 10000; range 1-100000. */
    maxHistoryRows?: number;
  };
}
