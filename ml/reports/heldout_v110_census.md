# Held-out evaluation: `v110_census`

1559 labeled passes, 253 stations, 2026-10-23 21:17:20+00:00 to 2026-10-24 09:22:59+00:00. Status counts: {'good': 815, 'failed': 500, 'bad': 244}. Failure = bad or failed.

## Threshold 0.5

| split | variant | AUC | AP | precision | recall | F1 | accuracy | confusion [[TN, FP], [FN, TP]] |
|---|---|---|---|---|---|---|---|---|
| random | v110_station_id | 0.851 | 0.836 | 0.753 | 0.751 | 0.752 | 0.764 | [[632, 183], [185, 559]] |
| random | v110_no_station_id | 0.850 | 0.834 | 0.753 | 0.758 | 0.756 | 0.766 | [[630, 185], [180, 564]] |
| random | physical | 0.899 | 0.891 | 0.825 | 0.798 | 0.811 | 0.823 | [[689, 126], [150, 594]] |
| random | physical+history | 0.927 | 0.922 | 0.847 | 0.828 | 0.838 | 0.847 | [[704, 111], [128, 616]] |
| random | physical+history+weight | 0.927 | 0.922 | 0.846 | 0.839 | 0.842 | 0.850 | [[701, 114], [120, 624]] |
| random | physical+history+isotonic | 0.923 | 0.915 | 0.823 | 0.840 | 0.832 | 0.838 | [[681, 134], [119, 625]] |
| random | physical+online1h | 0.897 | 0.896 | 0.814 | 0.759 | 0.786 | 0.802 | [[686, 129], [179, 565]] |
| random | physical+online1h+weight | 0.898 | 0.897 | 0.809 | 0.773 | 0.790 | 0.804 | [[679, 136], [169, 575]] |
| random | physical+online1h+isotonic | 0.893 | 0.888 | 0.808 | 0.773 | 0.790 | 0.804 | [[678, 137], [169, 575]] |
| random | physical+history+online1h | 0.925 | 0.923 | 0.841 | 0.817 | 0.829 | 0.839 | [[700, 115], [136, 608]] |
| random | physical+online3h | 0.895 | 0.890 | 0.820 | 0.777 | 0.798 | 0.812 | [[688, 127], [166, 578]] |
| station | v110_station_id | 0.705 | 0.652 | 0.701 | 0.398 | 0.508 | 0.632 | [[689, 126], [448, 296]] |
| station | v110_no_station_id | 0.723 | 0.668 | 0.670 | 0.558 | 0.609 | 0.658 | [[611, 204], [329, 415]] |
| station | physical | 0.755 | 0.734 | 0.705 | 0.565 | 0.627 | 0.679 | [[639, 176], [324, 420]] |
| station | physical+history | 0.708 | 0.692 | 0.726 | 0.438 | 0.547 | 0.653 | [[692, 123], [418, 326]] |
| station | physical+history+weight | 0.709 | 0.695 | 0.713 | 0.441 | 0.545 | 0.648 | [[683, 132], [416, 328]] |
| station | physical+history+isotonic | 0.695 | 0.682 | 0.661 | 0.546 | 0.598 | 0.650 | [[607, 208], [338, 406]] |
| station | physical+online1h | 0.855 | 0.860 | 0.804 | 0.688 | 0.741 | 0.771 | [[690, 125], [232, 512]] |
| station | physical+online1h+weight | 0.859 | 0.862 | 0.810 | 0.703 | 0.753 | 0.779 | [[692, 123], [221, 523]] |
| station | physical+online1h+isotonic | 0.847 | 0.844 | 0.789 | 0.734 | 0.760 | 0.779 | [[669, 146], [198, 546]] |
| station | physical+history+online1h | 0.801 | 0.788 | 0.786 | 0.601 | 0.681 | 0.731 | [[693, 122], [297, 447]] |
| station | physical+online3h | 0.814 | 0.823 | 0.771 | 0.629 | 0.693 | 0.734 | [[676, 139], [276, 468]] |
| time | v110_station_id | 0.838 | 0.814 | 0.782 | 0.699 | 0.738 | 0.761 | [[198, 44], [68, 158]] |
| time | v110_no_station_id | 0.820 | 0.792 | 0.760 | 0.699 | 0.728 | 0.748 | [[192, 50], [68, 158]] |
| time | physical | 0.885 | 0.876 | 0.825 | 0.668 | 0.738 | 0.771 | [[210, 32], [75, 151]] |
| time | physical+history | 0.924 | 0.926 | 0.870 | 0.770 | 0.817 | 0.833 | [[216, 26], [52, 174]] |
| time | physical+history+weight | 0.921 | 0.924 | 0.858 | 0.774 | 0.814 | 0.829 | [[213, 29], [51, 175]] |
| time | physical+history+isotonic | 0.917 | 0.898 | 0.803 | 0.903 | 0.850 | 0.846 | [[192, 50], [22, 204]] |
| time | physical+online1h | 0.923 | 0.928 | 0.887 | 0.761 | 0.819 | 0.838 | [[220, 22], [54, 172]] |
| time | physical+online1h+weight | 0.923 | 0.928 | 0.880 | 0.779 | 0.826 | 0.842 | [[218, 24], [50, 176]] |
| time | physical+online1h+isotonic | 0.920 | 0.909 | 0.879 | 0.770 | 0.821 | 0.838 | [[218, 24], [52, 174]] |
| time | physical+history+online1h | 0.926 | 0.930 | 0.868 | 0.788 | 0.826 | 0.840 | [[215, 27], [48, 178]] |
| time | physical+online3h | 0.912 | 0.912 | 0.854 | 0.726 | 0.785 | 0.808 | [[214, 28], [62, 164]] |

## Precision targets (threshold chosen on inner OOF, measured on the outer fold)

| split | variant | target | precision | 95% CI | recall | recall failed / bad | flagged |
|---|---|---|---|---|---|---|---|
| random | v110_station_id | 0.90 | 0.885 | 0.84–0.92 | 0.289 | 0.33 / 0.21 | 243 |
| random | v110_station_id | 0.95 | 0.977 | 0.88–1.00 | 0.056 | 0.06 / 0.04 | 43 |
| random | v110_station_id | 0.98 | 1.000 | 0.70–1.00 | 0.012 | 0.02 / 0.00 | 9 |
| random | v110_no_station_id | 0.90 | 0.907 | 0.86–0.94 | 0.289 | 0.34 / 0.19 | 237 |
| random | v110_no_station_id | 0.95 | 0.946 | 0.82–0.99 | 0.047 | 0.06 / 0.02 | 37 |
| random | v110_no_station_id | 0.98 | 0.929 | 0.69–0.99 | 0.017 | 0.02 / 0.01 | 14 |
| random | physical | 0.90 | 0.902 | 0.87–0.93 | 0.569 | 0.64 / 0.42 | 469 |
| random | physical | 0.95 | 0.964 | 0.93–0.98 | 0.355 | 0.44 / 0.18 | 274 |
| random | physical | 0.98 | 0.955 | 0.91–0.98 | 0.171 | 0.22 / 0.07 | 133 |
| random | physical+history | 0.90 | 0.912 | 0.89–0.93 | 0.687 | 0.80 / 0.45 | 560 |
| random | physical+history | 0.95 | 0.948 | 0.92–0.96 | 0.562 | 0.72 / 0.23 | 441 |
| random | physical+history | 0.98 | 0.967 | 0.94–0.98 | 0.440 | 0.60 / 0.11 | 338 |
| random | physical+history+weight | 0.90 | 0.913 | 0.89–0.93 | 0.690 | 0.81 / 0.45 | 562 |
| random | physical+history+weight | 0.95 | 0.942 | 0.92–0.96 | 0.566 | 0.73 / 0.23 | 447 |
| random | physical+history+weight | 0.98 | 0.966 | 0.94–0.98 | 0.422 | 0.58 / 0.09 | 325 |
| random | physical+history+isotonic | 0.90 | 0.922 | 0.90–0.94 | 0.653 | 0.78 / 0.39 | 527 |
| random | physical+history+isotonic | 0.95 | 0.954 | 0.93–0.97 | 0.535 | 0.70 / 0.20 | 417 |
| random | physical+history+isotonic | 0.98 | 0.967 | 0.94–0.98 | 0.427 | 0.59 / 0.10 | 329 |
| random | physical+online1h | 0.90 | 0.896 | 0.87–0.92 | 0.589 | 0.68 / 0.40 | 489 |
| random | physical+online1h | 0.95 | 0.945 | 0.92–0.96 | 0.458 | 0.60 / 0.18 | 361 |
| random | physical+online1h | 0.98 | 0.978 | 0.95–0.99 | 0.362 | 0.51 / 0.06 | 275 |
| random | physical+online1h+weight | 0.90 | 0.902 | 0.87–0.93 | 0.582 | 0.68 / 0.39 | 480 |
| random | physical+online1h+weight | 0.95 | 0.944 | 0.92–0.96 | 0.453 | 0.60 / 0.16 | 357 |
| random | physical+online1h+weight | 0.98 | 0.982 | 0.96–0.99 | 0.364 | 0.52 / 0.05 | 276 |
| random | physical+online1h+isotonic | 0.90 | 0.902 | 0.87–0.93 | 0.554 | 0.66 / 0.33 | 457 |
| random | physical+online1h+isotonic | 0.95 | 0.962 | 0.94–0.98 | 0.438 | 0.58 / 0.14 | 339 |
| random | physical+online1h+isotonic | 0.98 | 0.978 | 0.95–0.99 | 0.352 | 0.50 / 0.05 | 268 |
| random | physical+history+online1h | 0.90 | 0.912 | 0.89–0.93 | 0.680 | 0.80 / 0.43 | 555 |
| random | physical+history+online1h | 0.95 | 0.947 | 0.92–0.96 | 0.578 | 0.74 / 0.25 | 454 |
| random | physical+history+online1h | 0.98 | 0.968 | 0.94–0.98 | 0.445 | 0.62 / 0.08 | 342 |
| random | physical+online3h | 0.90 | 0.900 | 0.87–0.92 | 0.569 | 0.65 / 0.41 | 470 |
| random | physical+online3h | 0.95 | 0.950 | 0.92–0.97 | 0.431 | 0.55 / 0.20 | 338 |
| random | physical+online3h | 0.98 | 0.962 | 0.93–0.98 | 0.270 | 0.38 / 0.04 | 209 |
| station | v110_station_id | 0.90 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| station | v110_station_id | 0.95 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| station | v110_station_id | 0.98 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| station | v110_no_station_id | 0.90 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| station | v110_no_station_id | 0.95 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| station | v110_no_station_id | 0.98 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| station | physical | 0.90 | 0.882 | 0.73–0.95 | 0.040 | 0.04 / 0.03 | 34 |
| station | physical | 0.95 | 1.000 | 0.21–1.00 | 0.001 | 0.00 / 0.00 | 1 |
| station | physical | 0.98 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| station | physical+history | 0.90 | 0.898 | 0.78–0.96 | 0.059 | 0.06 / 0.06 | 49 |
| station | physical+history | 0.95 | 1.000 | 0.44–1.00 | 0.004 | 0.00 / 0.00 | 3 |
| station | physical+history | 0.98 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| station | physical+history+weight | 0.90 | 0.921 | 0.79–0.97 | 0.047 | 0.04 / 0.07 | 38 |
| station | physical+history+weight | 0.95 | 0.941 | 0.73–0.99 | 0.022 | 0.02 / 0.02 | 17 |
| station | physical+history+weight | 0.98 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| station | physical+history+isotonic | 0.90 | 0.894 | 0.77–0.95 | 0.056 | 0.06 / 0.05 | 47 |
| station | physical+history+isotonic | 0.95 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| station | physical+history+isotonic | 0.98 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| station | physical+online1h | 0.90 | 0.889 | 0.86–0.92 | 0.496 | 0.62 / 0.25 | 415 |
| station | physical+online1h | 0.95 | 0.947 | 0.92–0.97 | 0.386 | 0.54 / 0.07 | 303 |
| station | physical+online1h | 0.98 | 0.960 | 0.92–0.98 | 0.223 | 0.33 / 0.01 | 173 |
| station | physical+online1h+weight | 0.90 | 0.893 | 0.86–0.92 | 0.516 | 0.63 / 0.28 | 430 |
| station | physical+online1h+weight | 0.95 | 0.957 | 0.93–0.97 | 0.355 | 0.51 / 0.05 | 276 |
| station | physical+online1h+weight | 0.98 | 0.972 | 0.94–0.99 | 0.235 | 0.35 / 0.01 | 180 |
| station | physical+online1h+isotonic | 0.90 | 0.913 | 0.88–0.94 | 0.452 | 0.59 / 0.17 | 368 |
| station | physical+online1h+isotonic | 0.95 | 0.954 | 0.92–0.97 | 0.359 | 0.51 / 0.06 | 280 |
| station | physical+online1h+isotonic | 0.98 | 0.963 | 0.92–0.98 | 0.212 | 0.31 / 0.00 | 164 |
| station | physical+history+online1h | 0.90 | 0.882 | 0.82–0.92 | 0.200 | 0.24 / 0.13 | 169 |
| station | physical+history+online1h | 0.95 | 0.914 | 0.81–0.96 | 0.071 | 0.09 / 0.04 | 58 |
| station | physical+history+online1h | 0.98 | 1.000 | 0.44–1.00 | 0.004 | 0.00 / 0.00 | 3 |
| station | physical+online3h | 0.90 | 0.904 | 0.87–0.93 | 0.380 | 0.49 / 0.16 | 313 |
| station | physical+online3h | 0.95 | 0.940 | 0.90–0.96 | 0.293 | 0.41 / 0.06 | 232 |
| station | physical+online3h | 0.98 | 0.979 | 0.94–0.99 | 0.191 | 0.28 / 0.00 | 145 |
| time | v110_station_id | 0.90 | 0.852 | 0.74–0.92 | 0.230 | 0.27 / 0.15 | 61 |
| time | v110_station_id | 0.95 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | v110_station_id | 0.98 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | v110_no_station_id | 0.90 | 0.859 | 0.75–0.92 | 0.243 | 0.28 / 0.15 | 64 |
| time | v110_no_station_id | 0.95 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | v110_no_station_id | 0.98 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | physical | 0.90 | 0.927 | 0.86–0.96 | 0.451 | 0.55 / 0.22 | 110 |
| time | physical | 0.95 | 0.964 | 0.90–0.99 | 0.354 | 0.43 / 0.18 | 83 |
| time | physical | 0.98 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | physical+history | 0.90 | 0.909 | 0.85–0.94 | 0.659 | 0.79 / 0.35 | 164 |
| time | physical+history | 0.95 | 0.955 | 0.90–0.98 | 0.558 | 0.71 / 0.21 | 132 |
| time | physical+history | 0.98 | 0.982 | 0.94–0.99 | 0.478 | 0.62 / 0.15 | 110 |
| time | physical+history+weight | 0.90 | 0.898 | 0.84–0.94 | 0.659 | 0.78 / 0.37 | 166 |
| time | physical+history+weight | 0.95 | 0.959 | 0.91–0.98 | 0.513 | 0.65 / 0.19 | 121 |
| time | physical+history+weight | 0.98 | 0.982 | 0.94–1.00 | 0.482 | 0.61 / 0.18 | 111 |
| time | physical+history+isotonic | 0.90 | 0.909 | 0.85–0.94 | 0.659 | 0.79 / 0.35 | 164 |
| time | physical+history+isotonic | 0.95 | 0.952 | 0.90–0.98 | 0.522 | 0.66 / 0.19 | 124 |
| time | physical+history+isotonic | 0.98 | 0.982 | 0.94–0.99 | 0.478 | 0.62 / 0.15 | 110 |
| time | physical+online1h | 0.90 | 0.940 | 0.89–0.97 | 0.624 | 0.77 / 0.28 | 150 |
| time | physical+online1h | 0.95 | 0.950 | 0.90–0.98 | 0.584 | 0.75 / 0.19 | 139 |
| time | physical+online1h | 0.98 | 0.968 | 0.92–0.99 | 0.535 | 0.72 / 0.12 | 125 |
| time | physical+online1h+weight | 0.90 | 0.935 | 0.88–0.96 | 0.633 | 0.78 / 0.29 | 153 |
| time | physical+online1h+weight | 0.95 | 0.944 | 0.89–0.97 | 0.593 | 0.75 / 0.22 | 142 |
| time | physical+online1h+weight | 0.98 | 0.983 | 0.94–1.00 | 0.527 | 0.71 / 0.10 | 121 |
| time | physical+online1h+isotonic | 0.90 | 0.950 | 0.90–0.98 | 0.593 | 0.75 / 0.22 | 141 |
| time | physical+online1h+isotonic | 0.95 | 0.950 | 0.90–0.98 | 0.584 | 0.75 / 0.19 | 139 |
| time | physical+online1h+isotonic | 0.98 | 0.968 | 0.92–0.99 | 0.535 | 0.72 / 0.12 | 125 |
| time | physical+history+online1h | 0.90 | 0.941 | 0.89–0.97 | 0.637 | 0.80 / 0.26 | 153 |
| time | physical+history+online1h | 0.95 | 0.969 | 0.92–0.99 | 0.562 | 0.72 / 0.21 | 131 |
| time | physical+history+online1h | 0.98 | 0.991 | 0.95–1.00 | 0.491 | 0.65 / 0.13 | 112 |
| time | physical+online3h | 0.90 | 0.918 | 0.86–0.95 | 0.593 | 0.74 / 0.25 | 146 |
| time | physical+online3h | 0.95 | 0.925 | 0.87–0.96 | 0.544 | 0.72 / 0.13 | 133 |
| time | physical+online3h | 0.98 | 0.936 | 0.88–0.97 | 0.518 | 0.69 / 0.12 | 125 |
