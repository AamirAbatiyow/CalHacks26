# Held-out evaluation: `v110`

3500 labeled passes, 326 stations, 2026-10-22 20:38:14+00:00 to 2026-10-24 09:22:59+00:00. Status counts: {'good': 2000, 'bad': 1000, 'failed': 500}. Failure = bad or failed.

## Threshold 0.5

| split | variant | AUC | AP | precision | recall | F1 | accuracy | confusion [[TN, FP], [FN, TP]] |
|---|---|---|---|---|---|---|---|---|
| random | v110_station_id | 0.881 | 0.841 | 0.777 | 0.745 | 0.761 | 0.799 | [[1679, 321], [382, 1118]] |
| random | v110_no_station_id | 0.874 | 0.838 | 0.766 | 0.724 | 0.744 | 0.787 | [[1668, 332], [414, 1086]] |
| random | physical | 0.919 | 0.906 | 0.843 | 0.791 | 0.816 | 0.847 | [[1779, 221], [314, 1186]] |
| random | physical+history | 0.931 | 0.918 | 0.829 | 0.831 | 0.830 | 0.854 | [[1742, 258], [253, 1247]] |
| random | physical+history+weight | 0.932 | 0.919 | 0.807 | 0.851 | 0.829 | 0.849 | [[1695, 305], [223, 1277]] |
| random | physical+history+isotonic | 0.929 | 0.914 | 0.833 | 0.819 | 0.826 | 0.852 | [[1754, 246], [272, 1228]] |
| random | physical+online1h | 0.930 | 0.919 | 0.855 | 0.783 | 0.817 | 0.850 | [[1800, 200], [325, 1175]] |
| random | physical+online1h+weight | 0.930 | 0.920 | 0.830 | 0.814 | 0.822 | 0.849 | [[1750, 250], [279, 1221]] |
| random | physical+online1h+isotonic | 0.928 | 0.915 | 0.846 | 0.775 | 0.809 | 0.843 | [[1789, 211], [338, 1162]] |
| random | physical+history+online1h | 0.933 | 0.923 | 0.827 | 0.819 | 0.823 | 0.849 | [[1744, 256], [272, 1228]] |
| random | physical+online3h | 0.928 | 0.917 | 0.852 | 0.787 | 0.818 | 0.850 | [[1795, 205], [320, 1180]] |
| station | v110_station_id | 0.776 | 0.729 | 0.736 | 0.464 | 0.569 | 0.699 | [[1750, 250], [804, 696]] |
| station | v110_no_station_id | 0.798 | 0.747 | 0.703 | 0.587 | 0.640 | 0.717 | [[1628, 372], [620, 880]] |
| station | physical | 0.851 | 0.830 | 0.779 | 0.637 | 0.701 | 0.767 | [[1729, 271], [544, 956]] |
| station | physical+history | 0.818 | 0.808 | 0.773 | 0.589 | 0.668 | 0.750 | [[1741, 259], [617, 883]] |
| station | physical+history+weight | 0.818 | 0.807 | 0.729 | 0.641 | 0.682 | 0.744 | [[1642, 358], [538, 962]] |
| station | physical+history+isotonic | 0.814 | 0.799 | 0.784 | 0.577 | 0.665 | 0.751 | [[1761, 239], [634, 866]] |
| station | physical+online1h | 0.900 | 0.892 | 0.861 | 0.705 | 0.775 | 0.825 | [[1829, 171], [442, 1058]] |
| station | physical+online1h+weight | 0.898 | 0.890 | 0.844 | 0.738 | 0.788 | 0.829 | [[1796, 204], [393, 1107]] |
| station | physical+online1h+isotonic | 0.895 | 0.884 | 0.823 | 0.764 | 0.792 | 0.828 | [[1753, 247], [354, 1146]] |
| station | physical+history+online1h | 0.863 | 0.861 | 0.855 | 0.647 | 0.737 | 0.802 | [[1835, 165], [529, 971]] |
| station | physical+online3h | 0.888 | 0.877 | 0.853 | 0.690 | 0.763 | 0.816 | [[1822, 178], [465, 1035]] |
| time | v110_station_id | 0.737 | 0.731 | 0.640 | 0.707 | 0.672 | 0.666 | [[340, 202], [149, 359]] |
| time | v110_no_station_id | 0.744 | 0.746 | 0.637 | 0.720 | 0.676 | 0.666 | [[333, 209], [142, 366]] |
| time | physical | 0.767 | 0.769 | 0.778 | 0.526 | 0.627 | 0.698 | [[466, 76], [241, 267]] |
| time | physical+history | 0.841 | 0.828 | 0.815 | 0.596 | 0.689 | 0.739 | [[473, 69], [205, 303]] |
| time | physical+history+weight | 0.836 | 0.820 | 0.800 | 0.636 | 0.708 | 0.747 | [[461, 81], [185, 323]] |
| time | physical+history+isotonic | 0.812 | 0.744 | 1.000 | 0.014 | 0.027 | 0.523 | [[542, 0], [501, 7]] |
| time | physical+online1h | 0.829 | 0.815 | 0.807 | 0.593 | 0.683 | 0.734 | [[470, 72], [207, 301]] |
| time | physical+online1h+weight | 0.826 | 0.814 | 0.775 | 0.632 | 0.696 | 0.733 | [[449, 93], [187, 321]] |
| time | physical+online1h+isotonic | 0.790 | 0.714 | 1.000 | 0.006 | 0.012 | 0.519 | [[542, 0], [505, 3]] |
| time | physical+history+online1h | 0.851 | 0.834 | 0.820 | 0.600 | 0.693 | 0.743 | [[475, 67], [203, 305]] |
| time | physical+online3h | 0.764 | 0.761 | 0.777 | 0.522 | 0.624 | 0.696 | [[466, 76], [243, 265]] |

## Precision targets (threshold chosen on inner OOF, measured on the outer fold)

| split | variant | target | precision | 95% CI | recall | recall failed / bad | flagged |
|---|---|---|---|---|---|---|---|
| random | v110_station_id | 0.90 | 0.905 | 0.88–0.93 | 0.386 | 0.40 / 0.38 | 640 |
| random | v110_station_id | 0.95 | 0.929 | 0.89–0.96 | 0.131 | 0.13 / 0.13 | 212 |
| random | v110_station_id | 0.98 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| random | v110_no_station_id | 0.90 | 0.908 | 0.88–0.93 | 0.350 | 0.32 / 0.37 | 578 |
| random | v110_no_station_id | 0.95 | 0.946 | 0.91–0.97 | 0.185 | 0.16 / 0.20 | 294 |
| random | v110_no_station_id | 0.98 | 0.973 | 0.91–0.99 | 0.048 | 0.02 / 0.06 | 74 |
| random | physical | 0.90 | 0.909 | 0.89–0.92 | 0.662 | 0.67 / 0.66 | 1092 |
| random | physical | 0.95 | 0.957 | 0.94–0.97 | 0.485 | 0.43 / 0.51 | 760 |
| random | physical | 0.98 | 0.983 | 0.97–0.99 | 0.317 | 0.20 / 0.37 | 484 |
| random | physical+history | 0.90 | 0.893 | 0.87–0.91 | 0.705 | 0.80 / 0.66 | 1183 |
| random | physical+history | 0.95 | 0.941 | 0.92–0.95 | 0.592 | 0.72 / 0.53 | 944 |
| random | physical+history | 0.98 | 0.972 | 0.96–0.98 | 0.445 | 0.57 / 0.38 | 686 |
| random | physical+history+weight | 0.90 | 0.894 | 0.87–0.91 | 0.716 | 0.81 / 0.67 | 1202 |
| random | physical+history+weight | 0.95 | 0.936 | 0.92–0.95 | 0.598 | 0.73 / 0.53 | 958 |
| random | physical+history+weight | 0.98 | 0.979 | 0.96–0.99 | 0.425 | 0.54 / 0.37 | 652 |
| random | physical+history+isotonic | 0.90 | 0.902 | 0.88–0.92 | 0.692 | 0.80 / 0.64 | 1151 |
| random | physical+history+isotonic | 0.95 | 0.949 | 0.93–0.96 | 0.560 | 0.69 / 0.50 | 885 |
| random | physical+history+isotonic | 0.98 | 0.973 | 0.96–0.98 | 0.441 | 0.57 / 0.38 | 679 |
| random | physical+online1h | 0.90 | 0.892 | 0.87–0.91 | 0.713 | 0.81 / 0.66 | 1199 |
| random | physical+online1h | 0.95 | 0.957 | 0.94–0.97 | 0.587 | 0.72 / 0.52 | 921 |
| random | physical+online1h | 0.98 | 0.983 | 0.97–0.99 | 0.463 | 0.62 / 0.39 | 706 |
| random | physical+online1h+weight | 0.90 | 0.899 | 0.88–0.92 | 0.708 | 0.80 / 0.66 | 1181 |
| random | physical+online1h+weight | 0.95 | 0.955 | 0.94–0.97 | 0.584 | 0.71 / 0.52 | 917 |
| random | physical+online1h+weight | 0.98 | 0.984 | 0.97–0.99 | 0.456 | 0.61 / 0.38 | 695 |
| random | physical+online1h+isotonic | 0.90 | 0.902 | 0.88–0.92 | 0.691 | 0.80 / 0.64 | 1149 |
| random | physical+online1h+isotonic | 0.95 | 0.969 | 0.96–0.98 | 0.548 | 0.68 / 0.48 | 848 |
| random | physical+online1h+isotonic | 0.98 | 0.983 | 0.97–0.99 | 0.456 | 0.61 / 0.38 | 696 |
| random | physical+history+online1h | 0.90 | 0.897 | 0.88–0.91 | 0.718 | 0.84 / 0.66 | 1201 |
| random | physical+history+online1h | 0.95 | 0.950 | 0.93–0.96 | 0.605 | 0.77 / 0.52 | 955 |
| random | physical+history+online1h | 0.98 | 0.976 | 0.96–0.99 | 0.463 | 0.67 / 0.36 | 712 |
| random | physical+online3h | 0.90 | 0.906 | 0.89–0.92 | 0.698 | 0.78 / 0.66 | 1155 |
| random | physical+online3h | 0.95 | 0.959 | 0.94–0.97 | 0.541 | 0.64 / 0.49 | 847 |
| random | physical+online3h | 0.98 | 0.987 | 0.97–0.99 | 0.410 | 0.48 / 0.37 | 623 |
| station | v110_station_id | 0.90 | 0.936 | 0.89–0.96 | 0.097 | 0.06 / 0.12 | 156 |
| station | v110_station_id | 0.95 | 0.984 | 0.92–1.00 | 0.042 | 0.02 / 0.05 | 64 |
| station | v110_station_id | 0.98 | 0.977 | 0.88–1.00 | 0.029 | 0.01 / 0.04 | 44 |
| station | v110_no_station_id | 0.90 | 0.914 | 0.83–0.96 | 0.049 | 0.03 / 0.06 | 81 |
| station | v110_no_station_id | 0.95 | 0.940 | 0.84–0.98 | 0.031 | 0.02 / 0.04 | 50 |
| station | v110_no_station_id | 0.98 | 0.900 | 0.74–0.97 | 0.018 | 0.01 / 0.02 | 30 |
| station | physical | 0.90 | 0.920 | 0.90–0.94 | 0.385 | 0.26 / 0.45 | 628 |
| station | physical | 0.95 | 0.975 | 0.96–0.99 | 0.285 | 0.14 / 0.36 | 438 |
| station | physical | 0.98 | 0.983 | 0.96–0.99 | 0.237 | 0.09 / 0.31 | 361 |
| station | physical+history | 0.90 | 0.919 | 0.89–0.94 | 0.385 | 0.28 / 0.44 | 629 |
| station | physical+history | 0.95 | 0.955 | 0.93–0.97 | 0.322 | 0.19 / 0.39 | 506 |
| station | physical+history | 0.98 | 0.977 | 0.96–0.99 | 0.249 | 0.09 / 0.33 | 383 |
| station | physical+history+weight | 0.90 | 0.913 | 0.89–0.93 | 0.385 | 0.28 / 0.44 | 633 |
| station | physical+history+weight | 0.95 | 0.963 | 0.94–0.98 | 0.309 | 0.17 / 0.38 | 481 |
| station | physical+history+weight | 0.98 | 0.984 | 0.97–0.99 | 0.249 | 0.09 / 0.33 | 380 |
| station | physical+history+isotonic | 0.90 | 0.946 | 0.92–0.96 | 0.337 | 0.19 / 0.41 | 534 |
| station | physical+history+isotonic | 0.95 | 0.964 | 0.94–0.98 | 0.299 | 0.15 / 0.38 | 466 |
| station | physical+history+isotonic | 0.98 | 0.979 | 0.96–0.99 | 0.245 | 0.08 / 0.33 | 375 |
| station | physical+online1h | 0.90 | 0.889 | 0.87–0.91 | 0.651 | 0.77 / 0.59 | 1099 |
| station | physical+online1h | 0.95 | 0.939 | 0.92–0.95 | 0.556 | 0.70 / 0.48 | 888 |
| station | physical+online1h | 0.98 | 0.981 | 0.97–0.99 | 0.407 | 0.58 / 0.32 | 622 |
| station | physical+online1h+weight | 0.90 | 0.892 | 0.87–0.91 | 0.641 | 0.77 / 0.58 | 1079 |
| station | physical+online1h+weight | 0.95 | 0.954 | 0.94–0.97 | 0.529 | 0.68 / 0.46 | 832 |
| station | physical+online1h+weight | 0.98 | 0.986 | 0.97–0.99 | 0.387 | 0.57 / 0.30 | 589 |
| station | physical+online1h+isotonic | 0.90 | 0.907 | 0.89–0.92 | 0.633 | 0.75 / 0.57 | 1046 |
| station | physical+online1h+isotonic | 0.95 | 0.939 | 0.92–0.95 | 0.546 | 0.68 / 0.48 | 872 |
| station | physical+online1h+isotonic | 0.98 | 0.986 | 0.97–0.99 | 0.368 | 0.56 / 0.27 | 560 |
| station | physical+history+online1h | 0.90 | 0.910 | 0.89–0.93 | 0.570 | 0.74 / 0.48 | 940 |
| station | physical+history+online1h | 0.95 | 0.954 | 0.94–0.97 | 0.473 | 0.60 / 0.41 | 743 |
| station | physical+history+online1h | 0.98 | 0.979 | 0.96–0.99 | 0.345 | 0.40 / 0.32 | 529 |
| station | physical+online3h | 0.90 | 0.874 | 0.85–0.89 | 0.601 | 0.69 / 0.56 | 1032 |
| station | physical+online3h | 0.95 | 0.948 | 0.93–0.96 | 0.469 | 0.57 / 0.42 | 743 |
| station | physical+online3h | 0.98 | 0.982 | 0.97–0.99 | 0.323 | 0.41 / 0.28 | 493 |
| time | v110_station_id | 0.90 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | v110_station_id | 0.95 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | v110_station_id | 0.98 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | v110_no_station_id | 0.90 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | v110_no_station_id | 0.95 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | v110_no_station_id | 0.98 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | physical | 0.90 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | physical | 0.95 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | physical | 0.98 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | physical+history | 0.90 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | physical+history | 0.95 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | physical+history | 0.98 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | physical+history+weight | 0.90 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | physical+history+weight | 0.95 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | physical+history+weight | 0.98 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | physical+history+isotonic | 0.90 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | physical+history+isotonic | 0.95 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | physical+history+isotonic | 0.98 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | physical+online1h | 0.90 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | physical+online1h | 0.95 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | physical+online1h | 0.98 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | physical+online1h+weight | 0.90 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | physical+online1h+weight | 0.95 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | physical+online1h+weight | 0.98 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | physical+online1h+isotonic | 0.90 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | physical+online1h+isotonic | 0.95 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | physical+online1h+isotonic | 0.98 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | physical+history+online1h | 0.90 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | physical+history+online1h | 0.95 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | physical+history+online1h | 0.98 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | physical+online3h | 0.90 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | physical+online3h | 0.95 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
| time | physical+online3h | 0.98 | – | ––– | 0.000 | 0.00 / 0.00 | 0 |
