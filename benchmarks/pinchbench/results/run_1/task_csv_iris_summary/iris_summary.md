# Iris Flowers Dataset — Statistical Summary

## Dataset Overview

| Property | Value |
|----------|-------|
| Total rows | 150 |
| Total columns | 5 (4 numeric, 1 categorical) |
| Numeric features | `sepal_length`, `sepal_width`, `petal_length`, `petal_width` |
| Categorical feature | `species` |

### Species Distribution

| Species | Count | Proportion |
|---------|-------|------------|
| setosa | 50 | 33.3% |
| versicolor | 50 | 33.3% |
| virginica | 50 | 33.3% |

The dataset is perfectly balanced across all three species.

---

## Overall Statistics

Summary statistics computed across all 150 observations:

| Feature | Mean | Median | Std Dev | Min | Max |
|---------|------|--------|---------|-----|-----|
| `sepal_length` | 5.843 | 5.80 | 0.828 | 4.3 | 7.9 |
| `sepal_width` | 3.057 | 3.00 | 0.436 | 2.0 | 4.4 |
| `petal_length` | 3.758 | 4.35 | 1.765 | 1.0 | 6.9 |
| `petal_width` | 1.199 | 1.30 | 0.762 | 0.1 | 2.5 |

**Notable:** `petal_length` has by far the highest standard deviation (1.765) and coefficient of variation (~47%), indicating it is the most variable feature. `sepal_width` is the least variable (CV ~14%).

---

## Per-Species Statistics

### Setosa

| Feature | Mean | Std Dev |
|---------|------|---------|
| `sepal_length` | 5.006 | 0.352 |
| `sepal_width` | 3.428 | 0.379 |
| `petal_length` | 1.462 | 0.174 |
| `petal_width` | 0.246 | 0.105 |

### Versicolor

| Feature | Mean | Std Dev |
|---------|------|---------|
| `sepal_length` | 5.936 | 0.516 |
| `sepal_width` | 2.770 | 0.314 |
| `petal_length` | 4.260 | 0.470 |
| `petal_width` | 1.326 | 0.198 |

### Virginica

| Feature | Mean | Std Dev |
|---------|------|---------|
| `sepal_length` | 6.588 | 0.636 |
| `sepal_width` | 2.974 | 0.322 |
| `petal_length` | 5.552 | 0.552 |
| `petal_width` | 2.026 | 0.275 |

---

## Correlation Analysis

Pairwise Pearson correlation coefficients across all 150 observations:

| Feature Pair | Pearson *r* |
|-------------|-------------|
| `petal_length` — `petal_width` | **0.9629** |
| `sepal_length` — `petal_length` | 0.8718 |
| `sepal_length` — `petal_width` | 0.8179 |
| `sepal_width` — `petal_length` | −0.4284 |
| `sepal_width` — `petal_width` | −0.3661 |
| `sepal_length` — `sepal_width` | −0.1176 |

### Strongest Correlation: `petal_length` and `petal_width` (*r* = 0.9629)

This near-perfect positive linear correlation means that petal length and petal width increase together almost proportionally. Biologically, this makes intuitive sense: larger flowers have petals that are both longer and wider. This strong coupling suggests that either measurement alone is almost as informative as both for characterizing flower size, and that a single "petal size" factor underlies much of the variation in the dataset. This pair would also be the most redundant if used together in a model that penalizes collinearity.

---

## Key Findings

1. **Setosa is clearly separable.** Setosa has dramatically smaller petals (mean petal length 1.46 cm vs. 4.26 cm for versicolor and 5.55 cm for virginica) with almost no overlap in petal measurements with the other two species. A simple threshold on petal length (e.g., ≤ 2.0 cm) perfectly classifies setosa.

2. **Versicolor and virginica overlap but are distinguishable.** Virginica has larger petals on average (5.55 cm long, 2.03 cm wide) than versicolor (4.26 cm long, 1.33 cm wide), but their ranges overlap, making them harder to separate with a single feature.

3. **Petal features are far more discriminative than sepal features.** The between-species spread relative to within-species variability is much larger for petal measurements. Sepal width, in particular, shows substantial overlap across all three species and has the weakest correlations with other features.

4. **Sepal width is inversely related to petal size.** The negative correlations between `sepal_width` and the petal features (r ≈ −0.37 to −0.43) indicate that flowers with larger petals tend to have narrower sepals—a somewhat counterintuitive geometric relationship.

5. **Petal length and petal width are nearly redundant** (*r* = 0.96). For dimensionality reduction or feature selection, keeping just one of these two features would capture almost all the information they jointly provide.

6. **The dataset is perfectly balanced** (50 samples per species), so accuracy metrics are straightforward to interpret without class-weight adjustments.
